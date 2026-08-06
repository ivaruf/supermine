/* =============================================================================
 * SUPERMINE — js/ui.js                         [OWNER: Agent 3 — presentation]
 * -----------------------------------------------------------------------------
 * Every piece of UI DOM is created at RUNTIME inside #ui-root, so index.html
 * never has to change. Nothing here draws to the canvas.
 *
 * LAYOUT (the centre of the screen is deliberately left empty)
 *   top-left      currency (animated count-up + pop), PWR / CUT / MAG chips,
 *                 resource multiplier chip
 *   top-centre    run progress bar + zone name + depth readout
 *   top-right     SOUND / RESTART buttons (44px touch targets)
 *   under bar     overdrive countdown bar (only while overdriving)
 *   upper-centre  upgrade announcement (big title + description)
 *   left edge     zone banner, slides in on zone:entered
 *   centre        end-of-run summary card (level:complete)
 *   fullscreen    "tap to start" overlay, dismissed on the first gesture
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
  var POP_MIN_GAP     = 0.14;   // seconds between currency pop animations
  var COMPACT_W       = 900;    // px viewport width that switches to compact
  var COMPACT_H       = 520;

  var ZONE_LABELS = {
    opening: 'SURFACE WORKINGS',
    rich:    'RICH SEAM',
    barrier: 'HARD BARRIER',
    narrow:  'NARROW PASS',
    final:   'THE MOTHERLODE'
  };

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
  var popCooldown = 0;
  var pendingPop = false;

  var multiplier = 1;
  var overdriveLeft = 0, overdriveTotal = 0;
  var zoneName = '';
  var summaryOpen = false;
  var started = false;

  // run stats for the summary card
  var statPickups = 0;
  var statBestBurst = 0;        // biggest value collected inside one burst
  var burstAcc = 0, burstTimer = 0;

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

    /* --- top-centre progress ------------------------------------------ */
    var progWrap = el('div', 'sm-progwrap', root);
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

    /* --- upgrade announcement (upper centre, above the machine) --------- */
    els.toast = el('div', 'sm-toast', root);
    els.toastKicker = el('div', 'sm-toast-kicker', els.toast, 'UPGRADE ACQUIRED');
    els.toastTitle = el('div', 'sm-toast-title', els.toast, '');
    els.toastSub = el('div', 'sm-toast-sub', els.toast, '');

    /* --- zone banner (left edge) ---------------------------------------- */
    els.banner = el('div', 'sm-banner', root);
    els.bannerText = el('div', 'sm-banner-text', els.banner, '');

    /* --- end of run summary --------------------------------------------- */
    els.summary = el('div', 'sm-summary', root);
    var card = el('div', 'sm-card', els.summary);
    el('div', 'sm-stripe', card);
    el('div', 'sm-card-kicker', card, 'EXCAVATION COMPLETE');
    els.sumTitle = el('div', 'sm-card-title', card, 'RUN COMPLETE');
    var grid = el('div', 'sm-card-grid', card);
    els.sumHaul   = statCell(grid, 'TOTAL HAUL', '0');
    els.sumDepth  = statCell(grid, 'DEPTH', '0 m');
    els.sumUpg    = statCell(grid, 'UPGRADES', '0');
    els.sumPick   = statCell(grid, 'RESOURCES', '0');
    els.sumPower  = statCell(grid, 'MINING POWER', '0');
    els.sumBurst  = statCell(grid, 'BEST BURST', '0');
    els.sumBtn = el('button', 'sm-btn sm-btn-primary sm-btn-big', card, 'RUN IT AGAIN');
    els.sumBtn.setAttribute('type', 'button');
    els.sumBtn.addEventListener('click', function (e) {
      e.preventDefault();
      SM.sound.play('ui');
      SM.events.emit('input:restart', null);
      els.sumBtn.blur();
    });

    /* --- start overlay ---------------------------------------------------- */
    els.start = el('div', 'sm-start', root);
    var sc = el('div', 'sm-start-inner', els.start);
    el('div', 'sm-start-logo', sc, 'SUPERMINE');
    el('div', 'sm-start-sub', sc, 'DRIVE. DESTROY. EXPAND.');
    el('div', 'sm-start-cta', sc, 'CLICK OR TAP TO START');
    el('div', 'sm-start-keys', sc, 'A / D or ARROWS or DRAG to steer  ·  R restart  ·  M mute');

    /* --- hint + debug ------------------------------------------------------ */
    els.hint = el('div', 'sm-hint', root, 'A / D  •  ARROWS  •  DRAG   —   R restart, M mute');
    els.debug = el('div', 'sm-debug', root, '');
    if (!C.DEBUG_STATS) els.debug.style.display = 'none';

    applyCompact();
  }

  function statCell(parent, label, value) {
    var cell = el('div', 'sm-cell', parent);
    el('div', 'sm-cell-label', cell, label);
    return el('div', 'sm-cell-value', cell, value);
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

  function onComplete(p) {
    if (!els.summary) return;
    summaryOpen = true;
    var dist = (p && p.distance) || (SM.level.getDistance ? SM.level.getDistance() : 0);
    setText('sumhaul', els.sumHaul, fmt(Math.round(currency)));
    setText('sumdepth', els.sumDepth, fmt(Math.round(dist)) + ' m');
    setText('sumupg', els.sumUpg, '' + (SM.vehicle.getUpgradeCount ? SM.vehicle.getUpgradeCount() : 0));
    setText('sumpick', els.sumPick, fmt(statPickups));
    setText('sumpower', els.sumPower, '' + Math.round(SM.vehicle.getMiningPower()));
    if (burstAcc > statBestBurst) statBestBurst = burstAcc;
    setText('sumburst', els.sumBurst, fmt(Math.round(statBestBurst)));
    els.summary.classList.add('sm-summary-on');
  }

  function onFirstGesture() {
    if (started) return;
    started = true;
    if (els.start) els.start.classList.add('sm-start-off');
    if (els.hint) els.hint.classList.add('sm-hint-fade');
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
      SM.events.on('gate:missed', function () { toast('GATE MISSED', 'Steer into the arch next time', 1.8); });
      SM.events.on('gate:passed', function () { pendingPop = true; });
      SM.events.on('level:complete', onComplete);
      SM.events.on('sound:muted', refreshMute);
      SM.events.on('input:firstgesture', onFirstGesture);
      SM.events.on('run:reset', reset);
      window.addEventListener('resize', onResize, false);
      window.addEventListener('orientationchange', onResize, false);
    }
    // The overlay itself unlocks audio: pointer-events are on until dismissed.
    if (els.start) {
      var go = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        SM.sound.play('ui');
        // Route through the canonical gesture path so 'input:firstgesture'
        // fires for everyone (sim start gate, audio unlock), not just the UI.
        SM.input.noteGesture();
        onFirstGesture();
      };
      els.start.addEventListener('pointerdown', go);
      els.start.addEventListener('click', go);
    }
    refreshMute();
  }

  function reset() {
    currency = 0;
    shown = 0;
    toastTimer = 0;
    bannerTimer = 0;
    multiplier = 1;
    overdriveLeft = 0;
    overdriveTotal = 0;
    statPickups = 0;
    statBestBurst = 0;
    burstAcc = 0;
    burstTimer = 0;
    summaryOpen = false;
    zoneName = '';
    if (els.toast) els.toast.classList.remove('sm-toast-on');
    if (els.banner) els.banner.classList.remove('sm-banner-on');
    if (els.summary) els.summary.classList.remove('sm-summary-on');
    if (els.odWrap) els.odWrap.classList.remove('sm-od-on');
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

    /* --- progress ------------------------------------------------------- */
    var p = SM.level.getProgress ? SM.level.getProgress() : 0;
    if (!(p >= 0)) p = 0;
    if (p > 1) p = 1;
    setText('progtxt', els.progText, Math.round(p * 100) + '%');
    setStyle('progw', els.progFill, 'width', (p * 100).toFixed(1) + '%');
    setText('zone', els.zoneLabel, zoneName);
    var dist = SM.level.getDistance ? SM.level.getDistance() : 0;
    setText('depth', els.depth, fmt(Math.round(dist)) + ' m');

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

    /* --- timed panels ------------------------------------------------------ */
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) els.toast.classList.remove('sm-toast-on');
    }
    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) els.banner.classList.remove('sm-banner-on');
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

  return {
    init: init,
    reset: reset,
    update: update,
    toast: toast,
    getCurrency: getCurrency,
    isSummaryOpen: function () { return summaryOpen; }
  };
})();
