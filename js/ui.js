/* =============================================================================
 * SUPERMINE — js/ui.js                         [OWNER: Agent 3 — presentation]
 * -----------------------------------------------------------------------------
 * Every piece of UI DOM is created at RUNTIME inside #ui-root, so index.html
 * never has to change. Nothing here draws to the canvas.
 *
 * LAYOUT (the centre of the screen is deliberately left empty)
 *   top-centre    THE COUNTDOWN — digits + a bar scaled by getTimeCap().
 *                 This is a TIME ATTACK: it is the thing the player watches,
 *                 so it sits above everything else and escalates as it drains.
 *   top-left      currency (animated count-up + pop), PWR / CUT / MAG chips,
 *                 resource multiplier chip
 *   under clock   run progress bar + zone name + depth readout
 *   top-right     SOUND / RESTART buttons (44px touch targets)
 *   under bar     overdrive countdown bar (only while overdriving)
 *   left edge     upgrade icon rail — one inline-SVG tile per owned upgrade
 *   upper-centre  upgrade announcement (big title + description)
 *   mid-screen    POWER-UP SPLASH — "+5 SEC" / "BOOST MODE", ~1s, the only
 *                 thing allowed into the middle of the screen and the only
 *                 HUD element you are meant to read without looking away
 *                 from the rock. Driven by time:granted (source 'cell') and
 *                 boost:start; both carry the amount actually granted.
 *   left edge     zone banner, slides in on zone:entered (offset past the rail)
 *   centre        end-of-run summary card + local top-10 table (run:over)
 *   fullscreen    "tap to start" overlay, dismissed on the first gesture
 *
 * THE RAIL IS REBUILT ON A VERSION NUMBER, NEVER PER FRAME
 *   SM.vehicle.getUpgradeVersion() only moves when an upgrade is applied, so
 *   update() compares one integer and does nothing 99.99% of the time. Even a
 *   rebuild only re-parses the SVG for tiles whose upgrade id actually changed.
 *
 * DOM WRITE DISCIPLINE — this is not optional
 *   update() runs inside the FIXED STEP, so it can be called up to 5x per
 *   rendered frame. Every write goes through setText()/setStyle(), which skip
 *   the write when the value has not changed. Touching textContent
 *   unconditionally forces layout ~180 times a second.
 *
 * Public API
 *   SM.ui.init() / reset() / update(dt)
 *   SM.ui.toast(title, subtitle, seconds)
 *   SM.ui.getCurrency()
 * ========================================================================== */

var SM = SM || {};

SM.ui = (function () {
  'use strict';

  /* =====================================================================
   * Agent-3 tunables
   * ================================================================== */
  var COUNTER_LERP    = 7.5;    // how fast the displayed currency chases reality
  var COUNTER_SNAP    = 0.7;
  var TOAST_TIME      = 2.8;
  var BANNER_TIME     = 2.2;
  // The power-up splash sits in the middle of the screen, over the rock you
  // are steering through, so it is timed to be GONE rather than to be read
  // twice: 1.1s is long enough to register "+5 SEC" at a glance and short
  // enough that it is never still there when the next decision arrives. The
  // CSS animation is authored to the same length.
  var SPLASH_TIME     = 1.1;
  var POP_MIN_GAP     = 0.14;   // seconds between currency pop animations
  var COMPACT_W       = 900;    // px viewport width that switches to compact
  var COMPACT_H       = 520;

  var TIME_WARN       = 20;     // seconds: the clock turns amber
  var TIME_URGENT     = 10;     // seconds: red, pulsing, one tick per second
  var TIME_DECIMALS   = 10;     // below this, show tenths — the drama is in them

  /* The build stamp shown on the menu. It lives HERE rather than in
   * config.js because config.js is frozen, and ui.js is the only module that
   * ever displays it. Bump it by hand when the game meaningfully changes. */
  var GAME_VERSION    = 'v1.2.0';

  var SCORE_KEY       = 'supermine.scores.v1';
  var SCORE_MAX       = 10;     // top ten, nothing else is kept
  var NAME_MAX        = 12;

  var ZONE_LABELS = {
    opening: 'SURFACE WORKINGS',
    rich:    'RICH SEAM',
    barrier: 'HARD BARRIER',
    narrow:  'NARROW PASS',
    final:   'THE MOTHERLODE'
  };

  /* ---------------------------------------------------------------------
   * UPGRADE GLYPHS
   * One inline SVG per upgrade id, hand-drawn on a 24x24 grid as line art so
   * a 22px tile still READS as the thing it grants: a blade looks like a
   * blade, the magnet like a magnet. No external assets, no emoji, no font
   * dependency. `currentColor` lets the tile theme the glyph.
   * ------------------------------------------------------------------ */
  function glyph(inner) {
    return '<svg class="sm-rail-svg" viewBox="0 0 24 24" fill="none" ' +
           'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" ' +
           'stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
  }

  var ICONS = {
    // wide toothed blade with spread arrows
    wider_blade: '<path d="M3 13.4h18"/>' +
      '<path d="M4 13.4l2-3.4 2 3.4 2-3.4 2 3.4 2-3.4 2 3.4 2-3.4 2 3.4"/>' +
      '<path d="M6.4 18.6H2.4m0 0 2.2-2.1m-2.2 2.1 2.2 2.1"/>' +
      '<path d="M17.6 18.6h4m0 0-2.2-2.1m2.2 2.1-2.2 2.1"/>',

    // three conical drill bits on collared shafts
    drill_heads: '<path d="M5 8.8l2.2 5H2.8z"/><path d="M5 13.8v6.8"/><path d="M3.3 16.4h3.4"/>' +
      '<path d="M12 3l2.6 6H9.4z"/><path d="M12 9v11.6"/><path d="M10.1 12.2h3.8"/>' +
      '<path d="M19 8.8l2.2 5h-4.4z"/><path d="M19 13.8v6.8"/><path d="M17.3 16.4h3.4"/>',

    // two toothed cutting discs on a common axle
    side_grinders: '<circle cx="5.6" cy="12" r="3.2"/><circle cx="18.4" cy="12" r="3.2"/>' +
      '<circle cx="5.6" cy="12" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="18.4" cy="12" r="1" fill="currentColor" stroke="none"/>' +
      '<path d="M5.6 8.8V7.1M5.6 15.2v1.7M2.4 12H0.7M3.3 9.7 2.1 8.5M3.3 14.3 2.1 15.5"/>' +
      '<path d="M18.4 8.8V7.1M18.4 15.2v1.7M21.6 12h1.7M20.7 9.7 21.9 8.5M20.7 14.3 21.9 15.5"/>' +
      '<path d="M8.9 12h6.2"/>',

    // pickaxe head + impact sparks
    mining_power: '<path d="M3 8.6c4.2-3.8 13.8-3.8 18 0"/>' +
      '<path d="M12 6.6v14.2"/>' +
      '<circle cx="12" cy="6.6" r="1.3" fill="currentColor" stroke="none"/>' +
      '<path d="M8.2 3.4l1.3 2.2M15.8 3.4l-1.3 2.2"/>',

    // stacked boost chevrons
    speed_up: '<path d="M5.8 10.2l6.2-5.8 6.2 5.8"/>' +
      '<path d="M5.8 15.4l6.2-5.8 6.2 5.8"/>' +
      '<path d="M5.8 20.6l6.2-5.8 6.2 5.8"/>',

    // horseshoe magnet with solid pole tips
    magnet: '<path d="M5 20.4V11a7 7 0 0 1 14 0v9.4"/>' +
      '<path d="M9 20.4V11a3 3 0 0 1 6 0v9.4"/>' +
      '<path d="M5 16.6h4v3.8H5z" fill="currentColor" stroke="none"/>' +
      '<path d="M15 16.6h4v3.8h-4z" fill="currentColor" stroke="none"/>',

    // heavy multiply cross ringed by ore facets
    multiplier: '<path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" stroke-width="2.9"/>' +
      '<path d="M12 1.6l1.5 1.5L12 4.6l-1.5-1.5z" fill="currentColor" stroke="none"/>' +
      '<path d="M12 19.4l1.5 1.5-1.5 1.5-1.5-1.5z" fill="currentColor" stroke="none"/>' +
      '<path d="M1.6 12l1.5-1.5L4.6 12l-1.5 1.5z" fill="currentColor" stroke="none"/>' +
      '<path d="M22.4 12l-1.5-1.5L19.4 12l1.5 1.5z" fill="currentColor" stroke="none"/>',

    // belt loop on rollers, running rearward
    rear_conveyor: '<rect x="2.4" y="9.6" width="19.2" height="7.4" rx="3.7"/>' +
      '<circle cx="7" cy="13.3" r="1.5"/><circle cx="12" cy="13.3" r="1.5"/>' +
      '<circle cx="17" cy="13.3" r="1.5"/>' +
      '<path d="M8.5 5.6h7m0 0-2.2-2.2m2.2 2.2-2.2 2.2"/>',

    // detonation core, uneven blast rays, broken shock ring
    explosive_pulse: '<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>' +
      '<circle cx="12" cy="12" r="7.2" stroke-opacity="0.45" stroke-dasharray="2.4 3.4"/>' +
      '<path d="M12 1.4v4.2M12 18.4v4.2M1.4 12h4.2M18.4 12h4.2"/>' +
      '<path d="M6.1 6.1l1.7 1.7M16.2 16.2l1.7 1.7M17.9 6.1l-1.7 1.7M7.8 16.2l-1.7 1.7"/>',

    // lightning bolt sealed in a hex core
    overdrive: '<path d="M12 2.2l8.4 4.9v9.8L12 21.8l-8.4-4.9V7.1z"/>' +
      '<path d="M13.4 6.2L8.4 13.2h3.1l-1.1 4.9 5.2-7h-3.2z" fill="currentColor" stroke="none"/>',

    // hopper funnel swallowing loose ore
    auto_hopper: '<path d="M3.4 5.6h17.2l-6 8v6.2l-5.2 2.2V13.6z"/>' +
      '<path d="M7.6 1.8v2M12 1.2v2.6M16.4 1.8v2"/>',

    // tracked drive unit
    mega_treads: '<rect x="2" y="7.6" width="20" height="9" rx="4.5"/>' +
      '<circle cx="7" cy="12.1" r="2.2"/><circle cx="17" cy="12.1" r="2.2"/>' +
      '<circle cx="12" cy="12.1" r="1.3"/>' +
      '<path d="M6 6.4v2.6M10 6.4v2.6M14 6.4v2.6M18 6.4v2.6"/>',

    // gear with a star core — the machine, finished
    final_overhaul: '<circle cx="12" cy="12" r="8.3"/>' +
      '<path d="M12 3.7V1.5M12 22.5v-2.2M3.7 12H1.5M22.5 12h-2.2"/>' +
      '<path d="M6.1 6.1L4.6 4.6M19.4 19.4l-1.5-1.5M17.9 6.1l1.5-1.5M4.6 19.4l1.5-1.5"/>' +
      '<path d="M12 7.2l1.5 3.1 3.4.5-2.5 2.4.6 3.4-3-1.6-3 1.6.6-3.4-2.5-2.4 3.4-.5z" ' +
      'fill="currentColor" stroke="none"/>'
  };

  // Anything the gameplay side adds later still gets a tile, not a hole.
  var ICON_FALLBACK = '<path d="M12 2.6l8.2 4.7v9.4L12 21.4 3.8 16.7V7.3z"/>' +
                      '<circle cx="12" cy="12" r="3.3"/>';

  var C = SM.config;

  var root = null;
  var els = {};
  var built = false;
  var subscribed = false;

  var currency = 0;              // true value
  var shown = 0;                 // animated value
  var lastStrings = {};

  var toastTimer = 0;
  var bannerTimer = 0;
  var splashTimer = 0;
  var popCooldown = 0;
  var pendingPop = false;

  var multiplier = 1;
  var overdriveLeft = 0, overdriveTotal = 0;
  var boostLeft = 0, boostTotal = 0;
  var freestyle = false;         // chosen on the menu, survives restarts
  var zoneName = '';
  var summaryOpen = false;
  var started = false;

  // run stats for the summary card
  var statPickups = 0;
  var statBestBurst = 0;        // biggest value collected inside one burst
  var burstAcc = 0, burstTimer = 0;

  // countdown
  var lastTickSec = -1;         // whole second the urgent tick last fired on

  // upgrade rail — rebuilt only when the version integer moves
  var railVersion = -1;
  var railTiles = [];

  /* --- haul tally ------------------------------------------------------
   * Two typed arrays indexed by matIndex, filled in onCollected(). That
   * handler fires ~30x per step during a torrent, so the hot path has to be
   * one integer increment and one float add — no string keys, no objects.
   * Both the live rail-side tally and the end-of-run breakdown are just
   * different views over these same buckets.
   * ------------------------------------------------------------------ */
  var MAT_N = (SM.materials && SM.materials.count) || 0;
  var oreCount = new Uint32Array(MAT_N);   // pieces collected, by matIndex
  var oreValue = new Float64Array(MAT_N);  // currency banked, by matIndex
  var tallyRows = [];                      // one per material, hidden until found
  var TALLY_REFRESH = 0.1;                 // seconds between count redraws
  var tallyTimer = 0;

  // Display order, most valuable material first, resolved once. Every row is
  // created up front and merely revealed on first pickup, so discovering a new
  // material never reorders or reflows the list — it just lights a row up.
  // Also the iteration order of the end-of-run breakdown, which is why POWER-UPS
  // ARE STILL IN HERE even though they no longer get a tally row (see below).
  var TALLY_ORDER = (function () {
    var l = (SM.materials && SM.materials.list) || [];
    var order = [];
    for (var i = 0; i < l.length; i++) order.push(i);
    order.sort(function (a, b) { return l[b].value - l[a].value; });
    return order;
  })();

  var SPOIL_COLOR = '#7f8792';

  // game over / high scores
  var runScore = 0, runDepth = 0;
  var scoreSaved = false;

  /* =====================================================================
   * DOM helpers
   * ================================================================== */
  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function setText(key, node, str) {
    if (!node || lastStrings[key] === str) return;
    lastStrings[key] = str;
    node.textContent = str;
  }

  function setStyle(key, node, prop, val) {
    if (!node || lastStrings[key] === val) return;
    lastStrings[key] = val;
    node.style[prop] = val;
  }

  function setClass(key, node, cls, on) {
    if (!node) return;
    var v = on ? 1 : 0;
    if (lastStrings[key] === v) return;
    lastStrings[key] = v;
    if (on) node.classList.add(cls); else node.classList.remove(cls);
  }

  /** Restart a CSS animation without forcing a synchronous reflow. */
  function retrigger(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    // Reading offsetWidth here would force layout; instead let the class land
    // on the next frame. Visually identical at 60 fps.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { node.classList.add(cls); });
    } else {
      node.classList.add(cls);
    }
  }

  function fmt(n) {
    // Manual grouping: toLocaleString allocates and we call this every frame.
    n = n | 0;
    if (n < 1000) return '' + n;
    var s = '' + n;
    var out = '';
    var c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c === 3 && i > 0) { out = ' ' + out; c = 0; }
    }
    return out;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /**
   * Clock face. Above ten seconds this is M:SS and only changes once a second,
   * so it costs one DOM write per second. Under ten it drops to tenths, which
   * is where the panic lives — and where a glance still parses one digit.
   */
  function fmtTime(t) {
    if (!(t > 0)) return '0.0';
    if (t < TIME_DECIMALS) return t.toFixed(1);
    var s = Math.ceil(t);
    var m = (s / 60) | 0;
    return m + ':' + pad2(s - m * 60);
  }

  function todayStr() {
    // Built by hand: toISOString() reports UTC, which can show "yesterday".
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* =====================================================================
   * HIGH SCORES — localStorage, defensive at every step
   * The game runs from file://, where storage can be missing, disabled or
   * throw on access. Every path degrades to "no high scores"; nothing here
   * may ever break the end screen.
   * ================================================================== */
  var storageOk = true;         // false once any storage call has thrown

  /** -> array (possibly empty), or null when storage is unusable. */
  function loadScores() {
    if (!storageOk) return null;
    var raw;
    try {
      if (!window.localStorage) { storageOk = false; return null; }
      raw = window.localStorage.getItem(SCORE_KEY);
    } catch (e) {
      storageOk = false;
      return null;
    }
    if (!raw) return [];
    var parsed;
    try { parsed = JSON.parse(raw); } catch (e2) { return []; }
    if (!parsed || typeof parsed.length !== 'number') return [];

    // Never trust what came out of storage: another build, a hand-edited
    // value or a truncated write all have to end up as a sane row or be
    // dropped. Names are only ever written with textContent, so there is no
    // markup path out of here.
    var out = [];
    for (var i = 0; i < parsed.length && i < 200; i++) {
      var e = parsed[i];
      if (!e || typeof e !== 'object') continue;
      var s = Number(e.score);
      if (!isFinite(s)) continue;
      var d = Number(e.depth);
      out.push({
        name:  String(e.name === undefined ? '???' : e.name).slice(0, NAME_MAX) || '???',
        score: Math.round(s),
        depth: isFinite(d) ? Math.round(d) : 0,
        date:  String(e.date === undefined ? '' : e.date).slice(0, 10)
      });
    }
    sortScores(out);
    if (out.length > SCORE_MAX) out.length = SCORE_MAX;
    return out;
  }

  function sortScores(list) {
    list.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return b.depth - a.depth;          // deeper run wins a tie
    });
  }

  function saveScores(list) {
    if (!storageOk) return false;
    try {
      window.localStorage.setItem(SCORE_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      storageOk = false;
      return false;
    }
  }

  function qualifies(score, list) {
    if (!list || score <= 0) return false;
    if (list.length < SCORE_MAX) return true;
    return score > list[list.length - 1].score;
  }

  /* =====================================================================
   * BUILD
   * ================================================================== */
  function build() {
    root = document.getElementById('ui-root');
    if (!root) return;
    root.innerHTML = '';
    built = true;

    /* --- top-left stat block ----------------------------------------- */
    var stats = el('div', 'sm-panel sm-stats', root);
    el('div', 'sm-stripe', stats);

    var cur = el('div', 'sm-currency', stats);
    el('span', 'sm-ico', cur, '◆');
    els.currency = el('span', 'sm-currency-val', cur, '0');
    els.currencyWrap = cur;

    var row = el('div', 'sm-statrow', stats);
    els.power  = el('div', 'sm-stat', row, 'PWR 0');
    els.blade  = el('div', 'sm-stat', row, 'CUT 0');
    els.magnet = el('div', 'sm-stat', row, 'MAG 0');
    els.mult   = el('div', 'sm-stat sm-stat-mult', row, '×1.0');

    /* --- top-centre COUNTDOWN ------------------------------------------ */
    // The gain float has to live OUTSIDE the panel: .sm-panel clips overflow,
    // and the "+10s" is supposed to fly up out of the clock.
    var clockWrap = el('div', 'sm-clockwrap', root);
    els.clockWrap = clockWrap;
    els.clock = el('div', 'sm-panel sm-clock', clockWrap);
    el('div', 'sm-stripe', els.clock);
    var clockInner = el('div', 'sm-clock-inner', els.clock);
    els.clockInner = clockInner;
    el('div', 'sm-clock-label', clockInner, 'TIME');
    els.clockDigits = el('div', 'sm-clock-digits', clockInner, '0:00');
    var clockBar = el('div', 'sm-clock-bar', els.clock);
    els.clockFill = el('div', 'sm-clock-fill', clockBar);
    els.clockGain = el('div', 'sm-clock-gain', clockWrap, '+10s');

    // update() only runs inside the fixed step, which main.js pins until the
    // first gesture — so without seeding it here the clock sits behind the
    // menu reading a dead 0:00 until the run actually starts.
    if (SM.level && SM.level.getTimeStart) {
      els.clockDigits.textContent = fmtTime(SM.level.getTimeStart());
    }

    // If the timed-run API is not present, hide the clock rather than show a
    // dead 0:00, and let the progress gauge take the top slot back.
    if (!(SM.level && SM.level.getTimeLeft)) {
      clockWrap.style.display = 'none';
      root.classList.add('sm-notimer');
    }

    /* --- top-centre progress (under the clock) -------------------------- */
    var progWrap = el('div', 'sm-progwrap', root);
    els.progWrap = progWrap;
    els.zoneLabel = el('div', 'sm-zonelabel', progWrap, '');
    var prog = el('div', 'sm-progress', progWrap);
    els.progFill = el('div', 'sm-progress-fill', prog);
    el('div', 'sm-progress-notches', prog);
    els.progText = el('div', 'sm-progress-text', prog, '0%');
    els.depth = el('div', 'sm-depth', progWrap, '0 m');

    /* --- overdrive bar (hidden unless overdriving) --------------------- */
    els.odWrap = el('div', 'sm-od', progWrap);
    el('div', 'sm-od-label', els.odWrap, 'OVERDRIVE');
    var odBar = el('div', 'sm-od-bar', els.odWrap);
    els.odFill = el('div', 'sm-od-fill', odBar);

    /* --- speed boost countdown (same shape, own colour) ----------------- */
    els.boostWrap = el('div', 'sm-od sm-boost', progWrap);
    el('div', 'sm-od-label', els.boostWrap, 'SPEED BOOST');
    var boostBar = el('div', 'sm-od-bar', els.boostWrap);
    els.boostFill = el('div', 'sm-od-fill', boostBar);

    /* --- top-right buttons --------------------------------------------- */
    var btns = el('div', 'sm-buttons', root);
    els.mute = el('button', 'sm-btn', btns, 'SOUND');
    els.restart = el('button', 'sm-btn sm-btn-primary', btns, 'RESTART');
    els.mute.setAttribute('type', 'button');
    els.restart.setAttribute('type', 'button');

    els.mute.addEventListener('click', function (e) {
      e.preventDefault();
      SM.sound.toggleMute();
      refreshMute();
      els.mute.blur();
    });
    els.restart.addEventListener('click', function (e) {
      e.preventDefault();
      SM.sound.play('ui');
      SM.events.emit('input:restart', null);
      els.restart.blur();
    });

    /* --- POWER-UP SPLASH (mid screen, above the machine) -----------------
     * The one thing on the HUD that is allowed into the middle of the screen,
     * and only for a second at a time. A power-up block is collected while you
     * are mid-corner at full speed with your eyes on the rock ahead — the
     * upgrade toast up at 21% is the wrong instrument for that moment, because
     * reading it costs you a glance you cannot afford. So: two words, in the
     * material's own colour, right where you are already looking.
     * The wash behind it is a deliberately WEAK sibling of the overdrive
     * colour grade in effects.js — same idea, a fifth of the alpha and half a
     * second instead of six, so a boost never gets mistaken for a frenzy. */
    els.splash = el('div', 'sm-splash', root);
    els.splashWash = el('div', 'sm-splash-wash', els.splash);
    var splashInner = el('div', 'sm-splash-inner', els.splash);
    els.splashBig = el('div', 'sm-splash-big', splashInner, '');
    els.splashSub = el('div', 'sm-splash-sub', splashInner, '');

    /* --- upgrade announcement (upper centre, above the machine) --------- */
    els.toast = el('div', 'sm-toast', root);
    els.toastKicker = el('div', 'sm-toast-kicker', els.toast, 'UPGRADE ACQUIRED');
    els.toastTitle = el('div', 'sm-toast-title', els.toast, '');
    els.toastSub = el('div', 'sm-toast-sub', els.toast, '');

    /* --- upgrade rail (left edge, under the stat block) ------------------ */
    // Column flex with wrap + a max-height: a very long run spills into a
    // second column instead of running off the bottom of the screen.
    els.rail = el('div', 'sm-rail', root);

    /* --- live haul tally (left edge, under the rail) --------------------- */
    // Bottom-anchored so it grows UPWARD toward the rail: the row you just
    // unlocked never shoves the others off the bottom of the screen.
    els.tally = el('div', 'sm-tally', root);
    el('div', 'sm-tally-head', els.tally, 'HAUL');
    tallyRows.length = 0;
    for (var ti = 0; ti < TALLY_ORDER.length; ti++) {
      // POWER-UPS GET NO ROW. They used to be pinned to the top of this list,
      // back when they were a common trickle and a running count was the only
      // feedback they had. They are now rare, they announce themselves with a
      // full-screen splash, and each has a live readout of its own (the clock
      // for cells, the SPEED BOOST bar for boosts) — so a third counter here
      // would be redundant, and worse: this panel is headed HAUL and the haul
      // IS the score. A row of "TIME CELL ×7" sitting above the gold is
      // exactly the "counted with the ore" reading we do not want. They still
      // appear on the end-of-run card, as a footnote under the breakdown.
      if (SM.materials.get(TALLY_ORDER[ti]).pickup) continue;
      tallyRows.push(makeTallyRow(TALLY_ORDER[ti]));
    }

    /* --- zone banner (left edge, offset clear of the rail) --------------- */
    els.banner = el('div', 'sm-banner', root);
    els.bannerText = el('div', 'sm-banner-text', els.banner, '');

    /* --- end of run summary --------------------------------------------- */
    els.summary = el('div', 'sm-summary', root);
    var card = el('div', 'sm-card', els.summary);
    el('div', 'sm-stripe', card);
    els.sumKicker = el('div', 'sm-card-kicker', card, 'EXCAVATION COMPLETE');
    els.sumTitle = el('div', 'sm-card-title', card, 'RUN COMPLETE');

    // The haul IS the score in a time attack, so it gets the hero slot.
    var score = el('div', 'sm-score', card);
    el('div', 'sm-score-label', score, 'FINAL SCORE');
    els.sumScore = el('div', 'sm-score-value', score, '0');

    // Where that score actually came from. Sits directly under the hero
    // number because it is the breakdown OF the hero number.
    els.haul = el('div', 'sm-haul', card);

    // No TOTAL HAUL cell: the haul is the score, and it is already the
    // biggest number on the card. TIME LEFT is the interesting one now —
    // zero on a timeout, whatever you had left if you reached the bottom.
    var grid = el('div', 'sm-card-grid', card);
    els.sumTime   = statCell(grid, 'TIME LEFT', '0.0 s');
    els.sumDepth  = statCell(grid, 'DEPTH', '0 m');
    els.sumUpg    = statCell(grid, 'UPGRADES', '0');
    els.sumPick   = statCell(grid, 'RESOURCES', '0');
    els.sumPower  = statCell(grid, 'MINING POWER', '0');
    els.sumBurst  = statCell(grid, 'BEST BURST', '0');
    /* --- local top-10 table + name entry --------------------------------- */
    var hs = el('div', 'sm-hs', card);
    el('div', 'sm-hs-head', hs, 'TOP HAULS');
    els.hsCta = el('div', 'sm-hs-cta', hs, 'NEW TOP 10 — ENTER YOUR NAME');
    els.hsForm = el('div', 'sm-hs-form', hs);
    els.hsInput = el('input', 'sm-hs-input', els.hsForm);
    els.hsInput.setAttribute('type', 'text');
    els.hsInput.setAttribute('maxlength', '' + NAME_MAX);
    els.hsInput.setAttribute('placeholder', 'YOUR NAME');
    els.hsInput.setAttribute('autocomplete', 'off');
    els.hsInput.setAttribute('autocorrect', 'off');
    els.hsInput.setAttribute('spellcheck', 'false');
    els.hsSave = el('button', 'sm-btn sm-btn-primary sm-hs-save', els.hsForm, 'SAVE');
    els.hsSave.setAttribute('type', 'button');
    els.hsRows = el('div', 'sm-hs-rows', hs);
    els.hsNote = el('div', 'sm-hs-note', hs, '');

    /* THE INTEGRATION HAZARD, AND THE FIX.
       input.js (frozen) listens for keydown on WINDOW in the bubble phase:
       there, 'r' restarts the run and 'm' toggles mute. Typing a name like
       MARCUS would therefore restart the game mid-entry. Because this input
       is the event TARGET and input.js listens at window afterwards, stopping
       propagation here means input.js never sees the key — while the browser
       still inserts the character, since we do NOT preventDefault. */
    els.hsInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();          // no implicit form submit / page reload
        submitScore();
      }
    });
    els.hsInput.addEventListener('keyup', function (e) { e.stopPropagation(); });
    els.hsInput.addEventListener('keypress', function (e) { e.stopPropagation(); });
    els.hsInput.addEventListener('input', function () {
      // Uppercase as you type. Only reassign when it actually differs, or the
      // caret jumps to the end on every keystroke.
      var v = els.hsInput.value.toUpperCase();
      if (v !== els.hsInput.value) els.hsInput.value = v;
    });
    els.hsSave.addEventListener('click', function (e) {
      e.preventDefault();
      submitScore();
    });

    els.sumBtn = el('button', 'sm-btn sm-btn-primary sm-btn-big', card, 'RUN IT AGAIN');
    els.sumBtn.setAttribute('type', 'button');
    els.sumBtn.addEventListener('click', function (e) {
      e.preventDefault();
      SM.sound.play('ui');
      SM.events.emit('input:restart', null);
      els.sumBtn.blur();
    });

    /* --- start overlay / MAIN MENU ----------------------------------------
     * The overlay used to dismiss on a click ANYWHERE, which cannot survive a
     * mode choice — the whole panel is a hit target, so a stray tap would pick
     * a mode for you. The gesture now lives on the two mode cards only, and
     * they are what unlock audio.
     * ------------------------------------------------------------------ */
    var t0 = (SM.level && SM.level.getTimeStart) ? SM.level.getTimeStart() : 0;

    els.start = el('div', 'sm-start', root);
    var sc = el('div', 'sm-start-inner', els.start);

    var head = el('div', 'sm-start-head', sc);
    el('div', 'sm-start-logo', head, 'SUPERMINE');
    el('div', 'sm-start-sub', head, 'DRIVE. DESTROY. DIG DEEPER.');

    el('div', 'sm-start-pick', sc, 'CHOOSE YOUR RUN');

    var modes = el('div', 'sm-modes', sc);
    els.modeTime = modeCard(modes, 'time', 'TIME ATTACK',
      (t0 > 0 ? Math.round(t0) + ' SECONDS ON THE CLOCK' : 'BEAT THE CLOCK'),
      'Your haul when the clock hits zero is your score. Some gates pay ' +
      '+10 SECONDS instead of an upgrade — trade power for time.',
      'RANKED');
    els.modeFree = modeCard(modes, 'freestyle', 'FREESTYLE',
      'NO CLOCK · NO LIMIT',
      'Dig as far as you like. Nothing is timed and nothing ends the run — ' +
      'every gate pays an upgrade instead of seconds.',
      'SANDBOX');

    el('div', 'sm-start-keys', sc,
      'A / D  ·  ARROWS  ·  DRAG  to steer      R  restart      M  mute');

    /* --- opt-in update, shown only when a new build is parked and waiting --- */
    els.update = el('button', 'sm-update', sc, 'UPDATE READY — TAP TO INSTALL');
    els.update.setAttribute('type', 'button');
    els.update.style.display = 'none';
    els.update.addEventListener('click', function (e) {
      e.preventDefault();
      applyUpdate();
    });

    // Version, welded to the bottom of the menu panel. Replaced at runtime by
    // the version the SERVICE WORKER reports, which is the build actually
    // serving this session — GAME_VERSION is only the fallback for a plain
    // file:// or first-visit load where no worker is controlling yet.
    els.version = el('div', 'sm-start-version', els.start, GAME_VERSION);

    /* --- hint + debug ------------------------------------------------------ */
    // The menu owns the whole screen until a mode is picked. Without this the
    // in-game hint line sits at the bottom centre repeating the menu's own key
    // list and colliding with the version stamp.
    root.classList.add('sm-menu');

    els.hint = el('div', 'sm-hint', root, 'A / D  •  ARROWS  •  DRAG   —   R restart, M mute');
    els.debug = el('div', 'sm-debug', root, '');
    if (!C.DEBUG_STATS) els.debug.style.display = 'none';

    // Name entry only appears when a run actually qualifies.
    showForm(false);
    els.hsNote.style.display = 'none';

    applyCompact();
  }

  /**
   * One selectable mode card. Returns the node; the click handler is attached
   * in init() alongside the rest of the gesture plumbing.
   */
  function modeCard(parent, mode, title, tag, blurb, badge) {
    var card = el('button', 'sm-mode sm-mode-' + mode, parent);
    card.setAttribute('type', 'button');
    card.setAttribute('data-mode', mode);
    el('div', 'sm-stripe', card);
    el('div', 'sm-mode-badge', card, badge);
    el('div', 'sm-mode-title', card, title);
    el('div', 'sm-mode-tag', card, tag);
    el('div', 'sm-mode-blurb', card, blurb);
    el('div', 'sm-mode-go', card, 'START ▸');
    return card;
  }

  function statCell(parent, label, value) {
    var cell = el('div', 'sm-cell', parent);
    el('div', 'sm-cell-label', cell, label);
    return el('div', 'sm-cell-value', cell, value);
  }

  /* =====================================================================
   * UPGRADE RAIL
   * getOwnedUpgrades() is a LIVE, read-only array in acquisition order, so
   * tile i always describes upgrade i. That lets a "rebuild" reuse every
   * tile that has not changed and re-parse SVG only for a genuinely new id.
   * ================================================================== */
  function makeTile() {
    var node = el('div', 'sm-rail-tile', els.rail);
    var t = {
      node: node,
      icon: el('span', 'sm-rail-ico', node),
      badge: el('span', 'sm-rail-lv', node, ''),
      id: null,
      lvl: -1
    };
    t.badge.style.display = 'none';
    return t;
  }

  function rebuildRail() {
    if (!els.rail || !SM.vehicle.getOwnedUpgrades) return;
    var list = SM.vehicle.getOwnedUpgrades();
    if (!list) return;
    var n = list.length;

    for (var i = 0; i < n; i++) {
      var u = list[i];
      if (!u) continue;
      var t = railTiles[i];
      if (!t) { t = makeTile(); railTiles[i] = t; }

      if (t.id !== u.id) {
        t.id = u.id;
        t.icon.innerHTML = ICONS[u.id] ? glyph(ICONS[u.id]) : glyph(ICON_FALLBACK);
        t.node.setAttribute('title', u.title || u.id);
        t.node.style.display = '';
        t.lvl = -1;                       // force the badge pass below
        retrigger(t.node, 'sm-rail-pop');
      }

      var lv = (u.level > 1) ? (u.level | 0) : 1;
      if (lv !== t.lvl) {
        var first = (t.lvl === -1);
        t.lvl = lv;
        t.badge.textContent = lv > 1 ? ('' + lv) : '';
        t.badge.style.display = lv > 1 ? '' : 'none';
        if (!first) retrigger(t.node, 'sm-rail-pop');   // levelled, not gained
      }
    }

    // Only reachable if the owned list ever shrinks (a reset that skipped us).
    for (var j = n; j < railTiles.length; j++) {
      railTiles[j].node.style.display = 'none';
      railTiles[j].id = null;
      railTiles[j].lvl = -1;
    }
  }

  function clearRail() {
    railVersion = -1;
    railTiles.length = 0;
    if (els.rail) els.rail.innerHTML = '';
  }

  /* =====================================================================
   * HAUL TALLY — live counter of every material gathered
   * ---------------------------------------------------------------------
   * Rows exist from the start and are revealed on the first pickup of that
   * material, so the ordering is fixed for the whole run. updateTally() is
   * called from the fixed step, so it compares an integer per row and only
   * touches the DOM when a count has actually moved.
   * ================================================================== */
  function makeTallyRow(mi) {
    var m = SM.materials.get(mi);
    var node = el('div', 'sm-tally-row', els.tally);
    node.setAttribute('title', m.name);
    node.style.display = 'none';

    var sw = el('span', 'sm-tally-sw', node);
    // The swatch is the material's own base colour, so the row matches the
    // debris the player just watched fly into the collector.
    sw.style.background = m.colors[0];
    sw.style.boxShadow = '0 0 7px ' + m.colors[0];
    if (m.glow) sw.style.borderColor = m.colors[2];

    el('span', 'sm-tally-name', node, m.name);
    var cnt = el('span', 'sm-tally-count', node, '0');
    if (m.ore) node.classList.add('sm-tally-ore');

    return { mi: mi, node: node, count: cnt, shown: -1, on: false };
  }

  /**
   * @param flush  rewrite the count digits. See TALLY_REFRESH: in a rich seam
   *               every one of these counters moves on EVERY step, so writing
   *               them at the step rate made this the single biggest source of
   *               DOM churn in the HUD (measured: 107 mutations/sec, more than
   *               the stat block). Nobody reads a per-frame delta on "DIRT
   *               2 800", so the digits refresh at TALLY_REFRESH instead.
   *               A FIRST FIND still reveals its row immediately — that one is
   *               punctuation, and a tenth of a second late would read as lag.
   */
  function updateTally(flush) {
    for (var i = 0; i < tallyRows.length; i++) {
      var r = tallyRows[i];
      var c = oreCount[r.mi];
      if (c === r.shown) continue;          // the common case, every step
      var reveal = (c > 0 && !r.on);
      if (!flush && !reveal) continue;      // leave r.shown stale for the flush
      r.shown = c;
      r.count.textContent = fmt(c);
      if (reveal) {
        r.on = true;
        r.node.style.display = '';
        // Punctuate the first find only. Popping on every increment would
        // restart the animation dozens of times a second in a rich seam.
        retrigger(r.node, 'sm-tally-pop');
      }
    }
  }

  function resetTally() {
    tallyTimer = 0;
    for (var i = 0; i < MAT_N; i++) { oreCount[i] = 0; oreValue[i] = 0; }
    for (var j = 0; j < tallyRows.length; j++) {
      var r = tallyRows[j];
      r.shown = -1;
      r.on = false;
      r.node.style.display = 'none';
      r.node.classList.remove('sm-tally-pop');
    }
  }

  /* =====================================================================
   * END-OF-RUN HAUL BREAKDOWN
   * ---------------------------------------------------------------------
   * Runs once per run, so ordinary allocation is fine here.
   * Ores get their own coloured line, sorted by what they actually PAID
   * (not by their table value — 400 iron can out-earn three emeralds).
   * Everything non-ore folds into one SPOIL line: an itemised list of dirt,
   * stone and rubble would bury the two lines the player cares about.
   * ================================================================== */
  function renderHaul() {
    if (!els.haul) return;
    els.haul.innerHTML = '';

    var mats = SM.materials.list;
    var rows = [];
    var spoilVal = 0, spoilCount = 0;
    var picks = [];
    var i, mi, m, c;

    for (i = 0; i < TALLY_ORDER.length; i++) {
      mi = TALLY_ORDER[i];
      c = oreCount[mi];
      if (!c) continue;
      m = mats[mi];
      if (m.pickup) {
        // Power-ups paid in seconds, not currency. Keeping them out of the
        // rows is what lets the column still add up to exactly the score;
        // they get their own footnote under the table instead.
        // colors[2] as well as colors[0]: a power-up's base colour is a dark
        // machined casing (see materials.js), so the swatch needs the hot core
        // colour for its glow or the chip reads as a black dot on a black card.
        // `c` is only used as "did you get any at all" — see renderHaulPickups
        // for why the chip does NOT report it.
        picks.push({ kind: m.pickup, name: m.name, color: m.colors[0], glow: m.colors[2] });
      } else if (m.ore) {
        rows.push({ name: m.name, color: m.colors[0], count: c, value: oreValue[mi] });
      } else {
        spoilVal += oreValue[mi];
        spoilCount += c;
      }
    }
    rows.sort(function (a, b) { return b.value - a.value; });
    if (spoilCount > 0) {
      rows.push({
        name: 'Spoil', color: SPOIL_COLOR,
        count: spoilCount, value: spoilVal, spoil: true
      });
    }

    if (!rows.length && !picks.length) {
      el('div', 'sm-haul-empty', els.haul, 'NOTHING BANKED');
      return;
    }
    if (!rows.length) {
      el('div', 'sm-haul-empty', els.haul, 'NO ORE BANKED');
      renderHaulPickups(picks);
      return;
    }

    el('div', 'sm-haul-head', els.haul, 'WHERE IT CAME FROM');

    // Bars are scaled against the biggest single line, not the total, so the
    // composition is still readable when one ore dominates the run.
    var max = rows[0].value;
    for (i = 0; i < rows.length; i++) if (rows[i].value > max) max = rows[i].value;
    if (max <= 0) max = 1;

    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      var row = el('div', 'sm-haul-row', els.haul);
      if (r.spoil) row.classList.add('sm-haul-spoil');

      var bar = el('div', 'sm-haul-bar', row);
      bar.style.width = (r.value / max * 100).toFixed(1) + '%';
      bar.style.background = 'linear-gradient(90deg,' + r.color + '2e,' + r.color + '05)';

      var sw = el('span', 'sm-haul-sw', row);
      sw.style.background = r.color;
      sw.style.boxShadow = '0 0 8px ' + r.color;

      var name = el('span', 'sm-haul-name', row, r.name.toUpperCase());
      name.style.color = r.color;

      el('span', 'sm-haul-count', row, '×' + fmt(r.count));
      el('span', 'sm-haul-val', row, fmt(Math.round(r.value)));
    }

    renderHaulPickups(picks);
  }

  /**
   * Power-ups collected, as a footnote — they paid in seconds, not currency.
   *
   * COUNTED IN BLOCKS AND SECONDS, NEVER IN FRAGMENTS. The haul buckets count
   * collected particles, which is the right unit for ore ("×18 786 starcore"
   * genuinely means that many chips) and completely the wrong one here: a time
   * cell is a single object you steered for and hit maybe eight times in a
   * run, so the old "TIME CELL ×375" told the player they had picked up 375
   * of something they picked up eight of. level.js and vehicle.js each keep a
   * per-run block count and a per-run seconds total for exactly this line —
   * and seconds are what the player was actually buying, so they lead.
   */
  function renderHaulPickups(picks) {
    if (!picks || !picks.length) return;
    var note = el('div', 'sm-haul-picks', els.haul);
    for (var i = 0; i < picks.length; i++) {
      var p = picks[i];
      var blocks = 0, secs = 0;
      if (p.kind === 'time') {
        blocks = SM.level.getCellBlocks ? SM.level.getCellBlocks() : 0;
        secs = SM.level.getCellSeconds ? SM.level.getCellSeconds() : 0;
      } else if (p.kind === 'boost') {
        blocks = SM.vehicle.getBoostBlocks ? SM.vehicle.getBoostBlocks() : 0;
        secs = SM.vehicle.getBoostSeconds ? SM.vehicle.getBoostSeconds() : 0;
      }
      var chip = el('span', 'sm-haul-pick', note);
      var dot = el('span', 'sm-haul-sw', chip);
      dot.style.background = p.color;
      dot.style.boxShadow = '0 0 9px ' + (p.glow || p.color);
      dot.style.borderColor = p.glow || p.color;
      var lbl = el('span', 'sm-haul-pick-label', chip,
                   p.name.toUpperCase() + ' ×' + fmt(blocks) +
                   '  ·  +' + secs.toFixed(1) + 's');
      lbl.style.color = p.color;
    }
  }

  /* =====================================================================
   * HIGH SCORE TABLE
   * ================================================================== */
  function renderScores(list, highlight) {
    if (!els.hsRows) return;
    els.hsRows.innerHTML = '';
    if (!list) {
      setText('hsnote', els.hsNote, 'HIGH SCORES UNAVAILABLE — STORAGE IS BLOCKED');
      els.hsNote.style.display = '';
      return;
    }
    if (!list.length) {
      setText('hsnote', els.hsNote, 'NO RUNS RECORDED YET');
      els.hsNote.style.display = '';
      return;
    }
    els.hsNote.style.display = 'none';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var row = el('div', 'sm-hs-row' + (i === highlight ? ' sm-hs-row-new' : ''), els.hsRows);
      el('span', 'sm-hs-rank', row, '' + (i + 1));
      el('span', 'sm-hs-name', row, e.name);
      el('span', 'sm-hs-score', row, fmt(e.score));
      el('span', 'sm-hs-depth', row, fmt(e.depth) + ' m');
    }
  }

  function showForm(on) {
    if (!els.hsForm) return;
    els.hsForm.style.display = on ? '' : 'none';
    els.hsCta.style.display = on ? '' : 'none';
  }

  function submitScore() {
    if (scoreSaved || !els.hsInput) return;
    scoreSaved = true;

    var name = (els.hsInput.value || '').toUpperCase().replace(/\s+/g, ' ').replace(/^ | $/g, '');
    if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX);
    if (!name) name = 'MINER';

    var list = loadScores() || [];
    var entry = { name: name, score: runScore, depth: runDepth, date: todayStr() };
    list.push(entry);
    sortScores(list);
    if (list.length > SCORE_MAX) list.length = SCORE_MAX;

    var ok = saveScores(list);
    showForm(false);
    els.hsInput.blur();
    renderScores(list, list.indexOf(entry));
    if (!ok) {
      // The row is still shown — it just will not survive a reload.
      setText('hsnote', els.hsNote, 'COULD NOT WRITE TO STORAGE — THIS RUN WILL NOT BE KEPT');
      els.hsNote.style.display = '';
    }
    SM.sound.play('ui');
  }

  function refreshMute() {
    if (!els.mute) return;
    var m = SM.sound.isMuted();
    els.mute.textContent = m ? 'MUTED' : 'SOUND';
    if (m) els.mute.classList.add('sm-btn-off');
    else els.mute.classList.remove('sm-btn-off');
  }

  /** One class toggle drives every compact-layout rule in style.css. */
  function applyCompact() {
    if (!root) return;
    var w = window.innerWidth || 1024;
    var h = window.innerHeight || 768;
    var compact = (w < COMPACT_W || h < COMPACT_H);
    if (compact) root.classList.add('sm-compact');
    else root.classList.remove('sm-compact');
    if (w < 420) root.classList.add('sm-tiny');
    else root.classList.remove('sm-tiny');
  }

  var resizePending = false;
  function onResize() {
    if (resizePending) return;
    resizePending = true;
    // Coalesce bursts of resize events into one layout pass.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { resizePending = false; applyCompact(); });
    } else {
      resizePending = false;
      applyCompact();
    }
  }

  /* =====================================================================
   * EVENTS
   * ================================================================== */
  function onCollected(p) {
    // Particle values are baked at spawn (particles.js is frozen), so the
    // ORE REFINERY value multiplier must be applied here, at collection time.
    var v = p.value * multiplier;
    currency += v;
    statPickups++;
    burstAcc += v;
    burstTimer = 0.35;
    pendingPop = true;

    // Haul buckets. Two array writes, no branching beyond the bounds guard —
    // this runs ~30x per step when the collector is full.
    var mi = p.matIndex;
    if (mi >= 0 && mi < MAT_N) {
      oreCount[mi]++;
      oreValue[mi] += v;
    }
  }

  function onUpgrade(p) {
    toast(p && p.title ? p.title : 'UPGRADE', p && p.description ? p.description : '', TOAST_TIME);
  }

  function onZone(p) {
    var kind = (p && p.kind) || 'opening';
    zoneName = (p && p.name) || ZONE_LABELS[kind] || kind.toUpperCase();
    if (!els.banner) return;
    els.bannerText.textContent = zoneName;
    if (els.banner.classList) {
      els.banner.classList.remove('sm-banner-final');
      if (kind === 'final') els.banner.classList.add('sm-banner-final');
    }
    retrigger(els.banner, 'sm-banner-on');
    bannerTimer = BANNER_TIME;
  }

  function onMultiplier(p) {
    var v = (p && typeof p.value === 'number') ? p.value : (typeof p === 'number' ? p : 1);
    if (v === multiplier) return;
    multiplier = v;
    if (els.mult) retrigger(els.mult, 'sm-flash');
  }

  function onOverdriveStart(p) {
    overdriveTotal = (p && p.duration) || 6;
    overdriveLeft = overdriveTotal;
    setClass('odon', els.odWrap, 'sm-od-on', true);
  }

  function onOverdriveEnd() {
    overdriveLeft = 0;
    setClass('odon', els.odWrap, 'sm-od-on', false);
  }

  /* =====================================================================
   * POWER-UP SPLASH
   * ---------------------------------------------------------------------
   * Fired from two rare events, never from the step, so writing textContent
   * here unguarded is fine — it happens ~15 times in a four-minute run. The
   * only per-step cost is the timer in update().
   * ================================================================== */
  /**
   * @param kind  'time' | 'boost' | 'core' — picks the colour set in
   *              style.css. Classes rather than an inline colour so the whole
   *              treatment (text, glow, wash, sub) stays in the stylesheet.
   * @param big   the headline. ALWAYS the amount that was actually granted,
   *              never the amount a whole block is worth: clip the edge of a
   *              cell and it says +2 SEC, because it paid you two.
   */
  function splash(kind, big, sub) {
    if (!els.splash) return;
    els.splashBig.textContent = big;
    els.splashSub.textContent = sub;
    setClass('sptime', els.splash, 'sm-splash-time', kind === 'time');
    setClass('spboost', els.splash, 'sm-splash-boost', kind === 'boost');
    setClass('spcore', els.splash, 'sm-splash-core', kind === 'core');
    retrigger(els.splash, 'sm-splash-on');
    splashTimer = SPLASH_TIME;
  }

  /* --- speed boost -------------------------------------------------------
   * vehicle.js emits one boost:start per BLOCK (not per fragment), with the
   * total it ended up worth, so the bar is filled once and drains cleanly. */
  function onBoostStart(p) {
    boostTotal = (p && p.duration) || 1;
    boostLeft = boostTotal;
    setClass('bston', els.boostWrap, 'sm-od-on', true);
    if (els.clockInner) retrigger(els.clockInner, 'sm-clock-kick');
    // The bar under the progress gauge is the sustained readout; this is the
    // moment of collection. The duration goes in the SUB line because the
    // headline is the state you just entered, not a number.
    splash('boost', 'BOOST MODE', '+' + Math.round(boostTotal) + ' SEC  ·  SPEED SURGE');
  }

  function onBoostEnd() {
    boostLeft = 0;
    setClass('bston', els.boostWrap, 'sm-od-on', false);
  }

  /* --- the countdown -------------------------------------------------- */
  function onTimeGranted(p) {
    // Payload objects are reused: read now, stash nothing.
    var secs = (p && typeof p.seconds === 'number') ? p.seconds : 10;
    var source = (p && p.source) || 'gate';

    // A shattered TIME CELL has no other announcement of its own, so it gets
    // the splash. A +10 SECONDS GATE already owns a whole beat — the arch
    // flashes, the upgrade toast drops at 21%, the sound stings — and putting
    // a third headline for the same event in the middle of the screen just
    // makes the moment noisy. So the splash is the cell's voice, and the toast
    // stays the gate's. Anything that adds a new source lands here as 'gate'
    // and stays quiet until someone decides otherwise.
    if (source === 'cell') splash('time', '+' + Math.round(secs) + ' SEC', 'TIME CELL');

    if (!els.clockGain) return;
    els.clockGain.textContent = '+' + Math.round(secs) + 's';
    retrigger(els.clockGain, 'sm-clock-gain-on');
    retrigger(els.clockInner, 'sm-clock-kick');
    // A short kick sells the reward without stealing the frame.
    if (SM.camera && SM.camera.shake) SM.camera.shake(5);
  }

  function onTimeLow() {
    // The escalating clock STATE is derived from the value in update(), so a
    // restart re-arms itself. This handler is only the one-shot punctuation.
    if (els.clockInner) retrigger(els.clockInner, 'sm-clock-kick');
  }

  /* --- end of run ------------------------------------------------------ */
  function onRunOver(p) {
    var reason = (p && p.reason) || 'time';
    var dist = (p && typeof p.distance === 'number') ? p.distance
             : (SM.level.getDistance ? SM.level.getDistance() : 0);
    var left = (p && typeof p.timeLeft === 'number') ? p.timeLeft
             : (SM.level.getTimeLeft ? SM.level.getTimeLeft() : 0);
    openSummary(reason, dist, left);
  }

  /**
   * 100%. This used to open the end screen, because level.js ended the run
   * here. It does not any more: the core is the payoff zone and the clock is
   * the only exit, so this is a MILESTONE mid-run and the player is still
   * driving while it plays. It therefore gets the splash rather than a modal
   * — one second, out of the way, and it does not stop anything.
   */
  function onLevelComplete() {
    if (summaryOpen) return;
    splash('core', 'THE CORE', 'MAP CLEARED  ·  KEEP DIGGING');
  }

  function openSummary(reason, dist, timeLeft) {
    if (!els.summary || summaryOpen) return;
    summaryOpen = true;

    if (burstAcc > statBestBurst) statBestBurst = burstAcc;
    runScore = Math.round(currency);
    runDepth = Math.round(dist || 0);

    /* Every run now ends on the clock — reaching the bottom is something you
     * DID during the run, not a way to finish it. So the title reports the
     * achievement if there was one and the clock otherwise, and only the runs
     * that never made it get the red timeout treatment. `reason` is read
     * rather than assumed, so a future non-clock ending still lands somewhere
     * sensible instead of claiming the player ran out of time. */
    var reachedCore = !!(SM.level.isComplete && SM.level.isComplete());
    var outOfTime = (reason === 'time' || reason === undefined);
    // How deep INTO the core, because that is where the run's score was
    // actually earned — the last stretch is worth several times the whole
    // map above it, so the card should name it rather than bury it in DEPTH.
    var overtime = SM.level.getOvertime ? Math.round(SM.level.getOvertime()) : 0;
    setText('sumkick', els.sumKicker,
            reachedCore ? ('THE WHOLE MAP IS BEHIND YOU  ·  ' + fmt(overtime) + ' m INTO THE CORE')
                        : (outOfTime ? 'THE CLOCK BEAT YOU' : 'EXCAVATION ENDED'));
    setText('sumtitle', els.sumTitle,
            reachedCore ? 'YOU REACHED THE CORE' : "TIME'S UP");
    setClass('sumtimeout', els.summary, 'sm-summary-timeout', !reachedCore);

    setText('sumscore', els.sumScore, fmt(runScore));
    setText('sumtime', els.sumTime, (timeLeft > 0 ? timeLeft.toFixed(1) : '0.0') + ' s');
    setText('sumdepth', els.sumDepth, fmt(runDepth) + ' m');
    setText('sumupg', els.sumUpg, '' + (SM.vehicle.getUpgradeCount ? SM.vehicle.getUpgradeCount() : 0));
    setText('sumpick', els.sumPick, fmt(statPickups));
    setText('sumpower', els.sumPower, '' + Math.round(SM.vehicle.getMiningPower()));
    setText('sumburst', els.sumBurst, fmt(Math.round(statBestBurst)));

    /* --- what the score was actually made of ----------------------------- */
    renderHaul();

    /* --- high scores ---------------------------------------------------- */
    var list = loadScores();
    var canEnter = qualifies(runScore, list);
    scoreSaved = false;
    showForm(canEnter);
    renderScores(list, -1);
    els.summary.classList.add('sm-summary-on');

    if (canEnter) {
      els.hsInput.value = '';
      // Focus immediately: the field is already displayed (showForm above) and
      // an element can take focus while its container is still fading in.
      // Deferring to rAF only opened a window where a stray keypress went to
      // input.js instead of the name field.
      try { els.hsInput.focus(); } catch (e) { /* focus is optional */ }
    }
  }

  function onFirstGesture() {
    if (started) return;
    started = true;
    if (root) root.classList.remove('sm-menu');
    if (els.start) els.start.classList.add('sm-start-off');
    if (els.hint) els.hint.classList.add('sm-hint-fade');
  }

  /**
   * Leave the menu in the chosen mode.
   *
   * The mode has to be set BEFORE anything regenerates, because level.js
   * swaps the +10s gates for upgrades and terrain.js stops seeding time cells
   * — both of which are decided while the world is being built. main.restart()
   * re-runs that build in the documented order, so we set the mode and then
   * restart rather than trying to patch a half-built time-attack world.
   */
  function startRun(e, mode) {
    if (e && e.preventDefault) e.preventDefault();
    if (started) return;
    SM.sound.play('ui');

    if (SM.level.setMode) SM.level.setMode(mode);
    freestyle = !!(SM.level.isFreestyle && SM.level.isFreestyle());
    applyModeChrome();
    SM.main.restart();

    // Route through the canonical gesture path so 'input:firstgesture' fires
    // for everyone (sim start gate, audio unlock), not just the UI.
    SM.input.noteGesture();
    onFirstGesture();
  }

  /** Freestyle has no clock, so the countdown panel goes and the gauge rises. */
  function applyModeChrome() {
    if (!root) return;
    if (freestyle) root.classList.add('sm-notimer');
    else root.classList.remove('sm-notimer');
  }

  function toast(title, sub, seconds) {
    if (!els.toast) return;
    els.toastTitle.textContent = title;
    els.toastSub.textContent = sub || '';
    retrigger(els.toast, 'sm-toast-on');
    toastTimer = seconds || TOAST_TIME;
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    build();
    if (!subscribed) {
      subscribed = true;
      SM.events.on('resource:collected', onCollected);
      SM.events.on('upgrade:applied', onUpgrade);
      SM.events.on('zone:entered', onZone);
      SM.events.on('multiplier:changed', onMultiplier);
      SM.events.on('overdrive:start', onOverdriveStart);
      SM.events.on('overdrive:end', onOverdriveEnd);
      SM.events.on('boost:start', onBoostStart);
      SM.events.on('boost:end', onBoostEnd);
      SM.events.on('gate:missed', function () { toast('GATE MISSED', 'Steer into the arch next time', 1.8); });
      SM.events.on('gate:passed', function () { pendingPop = true; });
      SM.events.on('time:granted', onTimeGranted);
      SM.events.on('time:low', onTimeLow);
      SM.events.on('run:over', onRunOver);
      SM.events.on('level:complete', onLevelComplete);
      SM.events.on('sound:muted', refreshMute);
      SM.events.on('input:firstgesture', onFirstGesture);
      SM.events.on('run:reset', reset);
      window.addEventListener('resize', onResize, false);
      window.addEventListener('orientationchange', onResize, false);
    }
    /* The mode cards are the only way out of the menu, and they double as the
     * audio-unlock gesture. Bound on CLICK only: a pointerdown+click pair on
     * the same element fired twice, and the second one started the run again
     * after reset had already re-armed the overlay. */
    if (els.modeTime) els.modeTime.addEventListener('click', function (e) { startRun(e, 'time'); });
    if (els.modeFree) els.modeFree.addEventListener('click', function (e) { startRun(e, 'freestyle'); });
    refreshMute();
    initPWA();
  }

  function reset() {
    currency = 0;
    shown = 0;
    toastTimer = 0;
    bannerTimer = 0;
    splashTimer = 0;
    multiplier = 1;
    overdriveLeft = 0;
    overdriveTotal = 0;
    boostLeft = 0;
    boostTotal = 0;
    statPickups = 0;
    statBestBurst = 0;
    burstAcc = 0;
    burstTimer = 0;
    summaryOpen = false;
    zoneName = '';

    // countdown
    lastTickSec = -1;

    // game over / high scores
    runScore = 0;
    runDepth = 0;
    scoreSaved = false;

    if (els.toast) els.toast.classList.remove('sm-toast-on');
    if (els.banner) els.banner.classList.remove('sm-banner-on');
    // A restart mid-splash must not leave a "+5 SEC" hanging over a fresh run.
    // The colour classes go too, or the next splash inherits the last one's
    // hue for the frame before setClass() catches up (lastStrings is wiped at
    // the bottom of reset(), so those guards are re-armed either way).
    if (els.splash) {
      els.splash.classList.remove('sm-splash-on');
      els.splash.classList.remove('sm-splash-time');
      els.splash.classList.remove('sm-splash-boost');
    }
    if (els.summary) {
      els.summary.classList.remove('sm-summary-on');
      els.summary.classList.remove('sm-summary-timeout');
    }
    if (els.odWrap) els.odWrap.classList.remove('sm-od-on');
    if (els.boostWrap) els.boostWrap.classList.remove('sm-od-on');

    // The clock's escalation classes are re-derived from the value on the very
    // next update(), but they have to come off NOW or a restart flashes red.
    if (els.clock) {
      els.clock.classList.remove('sm-clock-warn');
      els.clock.classList.remove('sm-clock-urgent');
      els.clock.classList.remove('sm-clock-dead');
    }
    if (els.clockInner) els.clockInner.classList.remove('sm-clock-kick');
    if (els.clockGain) els.clockGain.classList.remove('sm-clock-gain-on');

    // The MODE is not run state — it is the player's menu choice, and RESTART
    // repeats it. Re-assert its chrome, since reset() runs on every restart.
    applyModeChrome();

    // Haul buckets and every tally row go back to zero / hidden.
    resetTally();
    if (els.haul) els.haul.innerHTML = '';

    // name entry back to a clean slate
    if (els.hsInput) { els.hsInput.blur(); els.hsInput.value = ''; }
    if (els.hsRows) els.hsRows.innerHTML = '';
    if (els.hsNote) { els.hsNote.textContent = ''; els.hsNote.style.display = 'none'; }
    showForm(false);

    clearRail();
    lastStrings = {};
  }

  function update(dt) {
    if (!root || !built) return;

    /* --- animated counter -------------------------------------------- */
    shown += (currency - shown) * Math.min(1, COUNTER_LERP * dt);
    if (Math.abs(currency - shown) < COUNTER_SNAP) shown = currency;
    setText('cur', els.currency, fmt(Math.floor(shown)));

    // Brief scale pop on gains, throttled so a loot torrent does not restart
    // the animation 60 times a second.
    popCooldown -= dt;
    if (pendingPop && popCooldown <= 0) {
      pendingPop = false;
      popCooldown = POP_MIN_GAP;
      retrigger(els.currencyWrap, 'sm-pop');
    }

    /* --- burst bookkeeping (for the summary card) --------------------- */
    if (burstTimer > 0) {
      burstTimer -= dt;
      if (burstTimer <= 0) {
        if (burstAcc > statBestBurst) statBestBurst = burstAcc;
        burstAcc = 0;
      }
    }

    /* --- stat chips ---------------------------------------------------- */
    setText('pwr', els.power, 'PWR ' + Math.round(SM.vehicle.getMiningPower()));
    setText('cut', els.blade, 'CUT ' + Math.round(SM.vehicle.getBladeWidth()));
    setText('mag', els.magnet, 'MAG ' + Math.round(SM.vehicle.getCollectRadius()));
    setText('mul', els.mult, '×' + (multiplier >= 10 ? Math.round(multiplier) : multiplier.toFixed(1)));
    setClass('mulon', els.mult, 'sm-stat-hot', multiplier > 1.01);

    /* --- THE COUNTDOWN ---------------------------------------------------
     * Every state here is DERIVED from the value rather than latched by an
     * event, so a restart (or a +10s that lifts you back over the wire)
     * re-arms the warning states for free. */
    if (els.clockWrap && SM.level.getTimeLeft && !freestyle) {
      var left = SM.level.getTimeLeft();
      if (!(left >= 0)) left = 0;
      var cap = SM.level.getTimeCap ? SM.level.getTimeCap() : 0;
      if (!(cap > 0)) cap = left > 0 ? left : 1;

      setText('clkd', els.clockDigits, fmtTime(left));
      var tf = left / cap;
      if (tf > 1) tf = 1; else if (tf < 0) tf = 0;
      setStyle('clkf', els.clockFill, 'width', (tf * 100).toFixed(1) + '%');

      var over = (SM.level.isRunOver && SM.level.isRunOver()) ||
                 (SM.vehicle.isHalted && SM.vehicle.isHalted());
      var dead = (left <= 0) || !!over;
      var urgent = !dead && left <= TIME_URGENT;
      setClass('clkdead', els.clock, 'sm-clock-dead', dead);
      setClass('clkurg', els.clock, 'sm-clock-urgent', urgent);
      setClass('clkwarn', els.clock, 'sm-clock-warn', !dead && !urgent && left <= TIME_WARN);

      // One tick per whole second inside the danger window.
      if (urgent && started) {
        var sec = Math.ceil(left);
        if (sec !== lastTickSec) { lastTickSec = sec; SM.sound.play('tick'); }
      } else if (lastTickSec !== -1) {
        lastTickSec = -1;
      }
    }

    /* --- upgrade rail ------------------------------------------------------
     * One integer compare per step. getUpgradeVersion() only moves when an
     * upgrade is applied, so the DOM is untouched on every other step. */
    if (els.rail) {
      var uv = SM.vehicle.getUpgradeVersion ? SM.vehicle.getUpgradeVersion()
             : (SM.vehicle.getUpgradeCount ? SM.vehicle.getUpgradeCount() : 0);
      if (uv !== railVersion) { railVersion = uv; rebuildRail(); }
    }

    /* --- live haul tally ---------------------------------------------------
     * One integer compare per material per step (11 of them). The digits are
     * rewritten on a slower cadence than the step — see updateTally(). */
    if (els.tally) {
      tallyTimer -= dt;
      var tflush = (tallyTimer <= 0);
      if (tflush) tallyTimer = TALLY_REFRESH;
      updateTally(tflush);
    }

    /* --- progress ------------------------------------------------------- */
    var p = SM.level.getProgress ? SM.level.getProgress() : 0;
    if (!(p >= 0)) p = 0;
    if (p > 1) p = 1;
    setStyle('progw', els.progFill, 'width', (p * 100).toFixed(1) + '%');
    setText('zone', els.zoneLabel, zoneName);
    var dist = SM.level.getDistance ? SM.level.getDistance() : 0;
    setText('depth', els.depth, fmt(Math.round(dist)) + ' m');

    /* --- OVERTIME ---------------------------------------------------------
     * Reaching 100% no longer ends the run (level.js), so the gauge would
     * otherwise sit pinned at a dead "100%" for the rest of the run — wasting
     * the one readout that should be shouting at you. Past the end it becomes
     * a depth-beyond-the-map counter instead, and the fill goes gold.
     *
     * ROUNDED TO 50 m ON PURPOSE — this is the THROTTLE, not a rounding
     * error. update() runs inside the fixed step, and at 200+ units a second
     * an exact metre count would rewrite the node on every single step. Fifty-
     * metre steps land at about four writes a second, and fifty metres is
     * already finer than anyone can read off a 15px bar. */
    var over = SM.level.getOvertime ? SM.level.getOvertime() : 0;
    setClass('progcore', els.progWrap, 'sm-prog-core', over > 0);
    setText('progtxt', els.progText, over > 0
      ? ('CORE  +' + fmt(Math.round(over / 50) * 50) + ' m')
      : (Math.round(p * 100) + '%'));

    /* --- overdrive countdown --------------------------------------------- */
    if (overdriveLeft > 0) {
      overdriveLeft -= dt;
      if (overdriveLeft <= 0) {
        overdriveLeft = 0;
        setClass('odon', els.odWrap, 'sm-od-on', false);
      } else {
        var frac = overdriveTotal > 0 ? overdriveLeft / overdriveTotal : 0;
        setStyle('odw', els.odFill, 'width', (frac * 100).toFixed(1) + '%');
      }
    }

    /* --- speed boost countdown -------------------------------------------- *
     * Driven from the vehicle's own remaining time rather than a local clock,
     * so a second block collected mid-boost refills the bar instead of letting
     * it keep draining. */
    if (boostLeft > 0) {
      var bl = SM.vehicle.getBoostLeft ? SM.vehicle.getBoostLeft() : (boostLeft - dt);
      boostLeft = bl;
      if (bl > boostTotal) boostTotal = bl;      // a top-up re-scales the bar
      if (bl <= 0) {
        boostLeft = 0;
        setClass('bston', els.boostWrap, 'sm-od-on', false);
      } else {
        var bfrac = boostTotal > 0 ? bl / boostTotal : 0;
        setStyle('bstw', els.boostFill, 'width', (bfrac * 100).toFixed(1) + '%');
      }
    }

    /* --- timed panels ------------------------------------------------------ */
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) els.toast.classList.remove('sm-toast-on');
    }
    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) els.banner.classList.remove('sm-banner-on');
    }
    if (splashTimer > 0) {
      splashTimer -= dt;
      if (splashTimer <= 0) els.splash.classList.remove('sm-splash-on');
    }

    /* --- debug ------------------------------------------------------------- */
    if (C.DEBUG_STATS) {
      var s = SM.particles.getStats();
      setText('dbg', els.debug,
        SM.main.getFps() + ' fps  ' + SM.main.getStepMs().toFixed(2) + ' ms  |  ' +
        s.active + ' p (' + s.solid + 's ' + s.loose + 'l)  |  fx ' + SM.effects.getCount() +
        '  |  z ' + SM.camera.getZoom().toFixed(2));
    }
  }

  function getCurrency() { return currency; }

  /* =====================================================================
   * PWA — install, offline play, and OPT-IN updates
   * ---------------------------------------------------------------------
   * sw.js precaches the whole build under one versioned cache. Registering
   * with { updateViaCache: 'none' } plus reg.update() on load means a bumped
   * sw.js VERSION is noticed at launch and precached in the background — but
   * the new worker then WAITS. It only takes over when the player taps UPDATE
   * READY on the menu, and the reload that follows happens ONLY from the menu.
   *
   * That restraint is the whole point. SUPERMINE is a 60-second score attack
   * with a local leaderboard; a worker that swapped itself in mid-run would
   * throw away an attempt, and reloading a half-finished run to install a
   * patch is a genuinely hostile thing to do to someone chasing a high score.
   *
   * Everything here is best-effort. The game must keep working when there is
   * no service worker at all — which is exactly the case when index.html is
   * opened straight off the disk over file://, where registration throws.
   * ================================================================== */
  var swReg = null;

  /** Ask a worker which build it is. Resolves null if it does not answer. */
  function swVersion(worker) {
    return new Promise(function (resolve) {
      if (!worker || typeof MessageChannel !== 'function') { resolve(null); return; }
      var ch = new MessageChannel();
      var bail = setTimeout(function () { resolve(null); }, 1500);
      ch.port1.onmessage = function (ev) {
        clearTimeout(bail);
        resolve((ev.data && ev.data.version) || null);
      };
      try { worker.postMessage({ type: 'GET_VERSION' }, [ch.port2]); }
      catch (e) { clearTimeout(bail); resolve(null); }
    });
  }

  function setVersionTag(v) {
    if (v && els.version) setText('ver', els.version, v);
  }

  function offerUpdate(version) {
    if (!els.update) return;
    els.update.textContent = (version ? version + ' READY' : 'UPDATE READY') +
                             ' — TAP TO INSTALL';
    els.update.style.display = '';
    els.update.classList.add('sm-update-on');
  }

  function applyUpdate() {
    if (!swReg || !swReg.waiting) return;
    SM.sound.play('ui');
    els.update.textContent = 'INSTALLING…';
    els.update.disabled = true;
    swReg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }

  /**
   * A FIRST install activates immediately and must never prompt — there is
   * nothing to upgrade from. Only offer when something already controls the
   * page, which is exactly the "this is an update" case.
   */
  function offerIfWaiting() {
    if (!swReg || !swReg.waiting || !navigator.serviceWorker.controller) return;
    swVersion(swReg.waiting).then(offerUpdate);
  }

  function initPWA() {
    if (!('serviceWorker' in navigator)) return;
    var hadController = !!navigator.serviceWorker.controller;

    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(function (reg) {
        swReg = reg;
        reg.update()['catch'](function () {});
        offerIfWaiting();              // one may be parked from a past launch
        reg.addEventListener('updatefound', function () {
          var w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', function () {
            if (w.state === 'installed') offerIfWaiting();
          });
        });
      })['catch'](function () { /* file:// or unsupported — the game is fine */ });

    // Show the build that is really serving us. On a first visit nothing
    // controls the page yet, so read the version straight out of sw.js.
    swVersion(navigator.serviceWorker.controller).then(function (v) {
      if (v) { setVersionTag(v); return; }
      fetch('sw.js').then(function (r) { return r.text(); }).then(function (t) {
        var m = t.match(/VERSION = '([^']+)'/);
        if (m) setVersionTag(m[1]);
      })['catch'](function () {});
    });

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // `started` is false only while the menu is up. Never reload mid-run.
      if (hadController && !started) location.reload();
    });
  }

  return {
    init: init,
    reset: reset,
    update: update,
    toast: toast,
    getCurrency: getCurrency,
    isSummaryOpen: function () { return summaryOpen; }
  };
})();
