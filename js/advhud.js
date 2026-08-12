/* =============================================================================
 * SUPERMINE — js/advhud.js                         [OWNER: Agent 4 — INTERFACE]
 * -----------------------------------------------------------------------------
 * THE IN-MINE INSTRUMENT PANEL. Everything the player needs to answer one
 * question without ever opening a menu: CAN I GET HOME FROM HERE?
 *
 * ---------------------------------------------------------------------------
 * WHAT IT SHOWS
 *   FUEL       the primary gauge. Big, and it changes character as it drains:
 *              healthy -> a reserve warning when what is left is close to what
 *              getting home costs (SM.adv.getReserveNeeded()) -> alarm.
 *   CARGO      a fill bar plus a compact manifest of what is actually in the
 *              hold, so "dump the coal" is a decision made from the HUD.
 *   DEPTH      metres, and the company balance beside it.
 *   HEAT       only once cooling matters — no dead gauge in Old Creek.
 *   HULL       ALWAYS, including at 100%. It carries between descents and it
 *              costs money to repair, so it has to be checkable before it is a
 *              problem rather than appearing once you are already in one.
 *   SCANNER    the headline contact from SM.scanner.getBest(), as a bearing and
 *              a distance in metres.
 *
 * WHERE IT ALL SITS — TWO LAYOUTS, ONE SET OF INSTRUMENTS
 *
 *   This used to read "the whole panel is a stack pinned to the TOP edge, on
 *   every viewport", and the argument for it was the thumb: the joystick's
 *   origin floats to wherever it lands, so the bottom of the screen is under
 *   the player's own hand. That half of the reasoning still holds. The other
 *   half was wrong, and on a phone it was wrong about the most important thing
 *   on the screen:
 *
 *       THE MINE MOUTH IS UP. -y is the surface. Climbing out means driving
 *       towards the top of the screen at the exact moment the tank is lowest
 *       and the decision matters most — and a 210 px full-width stack on an
 *       844 px phone put a quarter of the glass, opaque, over the shaft the
 *       player is trying to climb.
 *
 *   So the top belongs to the mine and the bottom belongs to the thumb, and
 *   the instruments go where NEITHER of them is: the two side edges.
 *
 *   COMPACT / PORTRAIT — THE RAILS  (.sm-compact, which ui.js publishes for
 *   any phone in either orientation and for a small desktop window)
 *     LEFT RAIL    FUEL. A 48 px vertical plate: the percentage, the state
 *                  word, and a tall bar that fills from the BOTTOM like a tank
 *                  with the reserve mark struck across it. Long and thin is
 *                  the right shape for this gauge — the taller the bar, the
 *                  more precisely you can read the level against the mark.
 *     RIGHT RAIL   HOLD. Fill level, capacity and worth, always visible; the
 *                  manifest is behind the count button at its foot and opens
 *                  INWARDS over the rock (see THE HOLD DRAWER below).
 *     BOTTOM EDGE  one line: DEPTH · FUNDS · HULL · HEAT, inside the
 *                  safe-area inset, BELOW where a thumb sits on the stick.
 *     ABOVE IT     the scanner contact, between the rails.
 *     TOP EDGE     nothing but the sound and pause plates in the corner. The
 *                  shaft, and the daylight at the end of it, is clear.
 *
 *   WIDE — THE STACK, UNCHANGED. At 1440x900 the stack is a 560 px column
 *   pinned top-LEFT while the machine is centred: it never covers the shaft,
 *   it has room for the fuel arithmetic in full (BURN, SECONDS LEFT) and for
 *   the manifest with no drawer. There was nothing to fix, so nothing changed.
 *
 *   Both layouts are the SAME DOM. Everything above is done in the stylesheet
 *   off ui.js's existing .sm-compact switch; no JS branch, no measuring, and
 *   no second set of elements to keep in step.
 *
 * HARD RULES INHERITED FROM ui.js — these are not style preferences
 *   1. update() RUNS INSIDE THE FIXED STEP, so it can be called several times
 *      per rendered frame. EVERY DOM write goes through the setText/setStyle/
 *      setClass/setVar helpers below, which skip the write when the value has
 *      not changed. The manifest and the scanner line are additionally rebuilt
 *      on a SLOW TIMER (SLOW_HZ), because deciding whether they changed means
 *      walking an array.
 *   2. Never measure. There is not one offsetWidth/getBoundingClientRect read
 *      in this file. Bars are driven by a --var and scaled by the stylesheet.
 *   3. Read-only. This module polls SM.adv and SM.scanner. The only writes are
 *      user actions: the pause button, and a two-tap confirm on a manifest row
 *      that calls SM.adv.dump() — "dump the coal" is the decision the manifest
 *      exists to support, and making it from the HUD is the whole point.
 *
 * PAUSE
 *   Adventure needs its own pause card: the classic one in ui.js is refused
 *   while adventure is active, because its RESTART and MAIN MENU buttons both
 *   rebuild the time-attack world. This one offers RESUME, ABORT RUN
 *   (SM.adv.abort() — costs the hold, like a strand) and a way back out.
 *   The simulation is gated with SM.main.setPaused(true/false) as usual.
 * ========================================================================== */

var SM = SM || {};

SM.advhud = (function () {
  'use strict';

  /* ----- Agent-4 tunables live here ----------------------------------- */

  var SLOW_HZ        = 8;      // manifest + scanner refreshes per second
  var ALERT_TIME     = 2.4;    // default banner seconds
  var MANIFEST_ROWS  = 5;      // rows shown before the "+N MORE" line
  var DUMP_CONFIRM   = 2.6;    // seconds an armed DUMP stays armed

  /* Fuel gauge character. RESERVE is what SM.adv says getting home costs; the
   * warning has to arrive BEFORE the tank hits it, or the instrument is just
   * announcing a failure that already happened. WARN_MARGIN is that head start,
   * expressed as a multiple of the reserve. */
  var WARN_MARGIN    = 1.75;   // fuel <= reserve * this  -> amber, "TURN BACK"
  var CRIT_MARGIN    = 1.05;   // fuel <= reserve * this  -> red, alarm
  var LOW_PCT        = 0.15;   // ...and never look healthy under this either

  var HEAT_SHOW      = 0.02;   // heat fraction below which the gauge is absent
  // (INTEG_SHOW removed: the hull gauge is now always shown — see update().)

  var ALERT_GAP      = 1.2;    // seconds between banners of the same kind

  var M_PER_UNIT = (SM.config && SM.config.ADV) ? SM.config.ADV.METERS_PER_UNIT : 0.1;

  /* ---------------------------------------------------------------------
   * GLYPHS — same 24x24 line-art discipline as ui.js's control icons. They
   * are copied rather than shared because ui.js does not export them and is
   * frozen; four path strings is a cheaper price than a change to a frozen
   * file.
   * ------------------------------------------------------------------ */
  var ICONS = {
    pause: '<rect x="7.2" y="4.6" width="3.7" height="14.8" rx="1.1" fill="currentColor" stroke="none"/>' +
           '<rect x="13.1" y="4.6" width="3.7" height="14.8" rx="1.1" fill="currentColor" stroke="none"/>',
    play: '<path d="M7.8 4.7 19.4 12 7.8 19.3z" fill="currentColor" stroke="none"/>',
    home: '<path d="M3.4 20.4h17.2"/><path d="M12 3.6v7.2"/>' +
          '<path d="M6.6 10.8h10.8v9.6H6.6z"/><path d="m7.4 3.6 9.2 7.2M16.6 3.6 7.4 10.8"/>',
    abort: '<path d="M12 3.2 21 19.4H3z"/><path d="M12 9v5"/>' +
           '<circle cx="12" cy="16.8" r="1.1" fill="currentColor" stroke="none"/>',
    sound_on: '<path d="M4.4 9.4h3.3l4.9-4.1v13.4l-4.9-4.1H4.4z"/>' +
              '<path d="M15.7 9.2a3.9 3.9 0 0 1 0 5.6"/><path d="M18.3 6.5a7.6 7.6 0 0 1 0 11"/>',
    sound_off: '<path d="M4.4 9.4h3.3l4.9-4.1v13.4l-4.9-4.1H4.4z"/>' +
               '<path d="m16.2 9.6 5.2 4.8M21.4 9.6l-5.2 4.8"/>',
    /* The manifest drawer's handle. A stack of lines is the one glyph that
     * reads as "a list of what is in there" at 12 px on a 48 px rail. */
    manifest: '<path d="M4.6 6.4h14.8M4.6 12h14.8M4.6 17.6h14.8"/>'
  };

  function glyph(inner) {
    return '<svg class="sm-btn-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
           'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
           inner + '</svg>';
  }

  /* ------------------------------------------------------------------ */

  var els = {};
  var built = false;
  var visible = false;
  var subscribed = false;
  var pauseOpen = false;

  var last = {};             // the "did it change?" cache, exactly as ui.js
  var slowTimer = 0;
  var alertTimer = 0;
  var alertClock = {};       // kind -> seconds since that kind last fired
  var dumpArmed = -1;        // matIndex with an armed confirm, -1 = none
  var dumpTimer = 0;

  var manifestRows = [];     // pooled row elements
  var manifestSig = '';
  var lodeHold = 0;          // seconds the banner keeps its motherlode dress

  /* =====================================================================
   * DOM helpers — the ui.js discipline, one cache per module
   * ================================================================== */
  function el(tag, cls, parent, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }

  function setText(key, node, str) {
    if (!node || last[key] === str) return;
    last[key] = str;
    node.textContent = str;
  }

  function setClass(key, node, cls, on) {
    if (!node) return;
    var v = on ? 1 : 0;
    if (last[key] === v) return;
    last[key] = v;
    if (on) node.classList.add(cls); else node.classList.remove(cls);
  }

  /** Guarded custom-property write. style[prop] does not reach `--vars`. */
  function setVar(key, node, prop, val) {
    if (!node || last[key] === val) return;
    last[key] = val;
    node.style.setProperty(prop, val);
  }

  function retrigger(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { node.classList.add(cls); });
    } else node.classList.add(cls);
  }

  function fmt(n) {
    n = Math.round(n) | 0;
    if (n < 1000) return '' + n;
    var s = '' + n, out = '', c = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      if (++c === 3 && i > 0) { out = ' ' + out; c = 0; }
    }
    return out;
  }

  function iconButton(parent, cls, icon, title) {
    var b = el('button', 'sm-btn sm-iconbtn ' + cls, parent);
    b.setAttribute('type', 'button');
    b.setAttribute('title', title);
    b.setAttribute('aria-label', title);
    b.innerHTML = glyph(icon);
    return b;
  }

  function menuButton(parent, cls, icon, label) {
    var b = el('button', 'sm-btn sm-pause-btn ' + cls, parent);
    b.setAttribute('type', 'button');
    var ico = el('span', 'sm-pause-ico', b);
    ico.innerHTML = glyph(icon);
    el('span', 'sm-pause-label', b, label);
    return b;
  }

  /* =====================================================================
   * SAFE READS ACROSS THE SEAM
   * Every getter here belongs to another agent and may be a stub returning a
   * placeholder while they work. num() is the difference between a HUD that
   * shows 0 and a HUD that throws.
   * ================================================================== */
  function num(v, dflt) {
    return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : dflt;
  }

  function A() { return SM.adv; }

  /** {name, color} for a material index, from whichever module can answer. */
  var dispOut = { name: '', color: '#8e9bab' };
  function displayOf(matIndex, matId) {
    dispOut.name = '';
    dispOut.color = '#8e9bab';
    var d = null;
    if (SM.mines && SM.mines.displayOf && matId) d = SM.mines.displayOf(matId);
    if (d) {
      dispOut.name = String(d.name || matId || '');
      dispOut.color = String(d.color || d.colour || dispOut.color);
      return dispOut;
    }
    var m = null;
    if (SM.materials) {
      if (typeof matIndex === 'number' && SM.materials.get) m = SM.materials.get(matIndex);
      if (!m && matId && SM.materials.getById) m = SM.materials.getById(matId);
    }
    if (m) {
      dispOut.name = String(m.name || m.id || '');
      dispOut.color = (m.colors && m.colors[0]) ? m.colors[0] : dispOut.color;
    } else {
      dispOut.name = String(matId || 'UNKNOWN');
    }
    return dispOut;
  }

  /* =====================================================================
   * BUILD
   * ================================================================== */
  function build() {
    var root = document.getElementById('ui-root');
    if (!root) return;
    built = true;

    els.root = el('div', 'sm-ah', root);

    /* --- row 1: where am I, and how far back is the door ---------------- */
    var strip = el('div', 'sm-panel sm-ah-strip', els.root);
    el('div', 'sm-stripe', strip);

    var dep = el('div', 'sm-ah-cell sm-ah-depth', strip);
    el('div', 'sm-ah-lbl', dep, 'DEPTH');
    els.depth = el('div', 'sm-ah-val', dep, '0 m');

    /* FUNDS, where TO SURFACE used to be.
     *
     * TO SURFACE was the same number as DEPTH — the mine mouth is depth zero, so
     * "how deep am I" and "how far back is the door" are one measurement wearing
     * two labels, and printing it twice just cost a slot.
     *
     * The company balance is genuinely useful down here instead: what the hold is
     * worth only means something next to what you already have, and it is the
     * number behind every "push on or go home" call. */
    var fu = el('div', 'sm-ah-cell sm-ah-funds', strip);
    el('div', 'sm-ah-lbl', fu, 'FUNDS');
    els.funds = el('div', 'sm-ah-val', fu, '$0');

    // HEAT and INTEGRITY are absent, not zeroed, until they mean something.
    els.heatCell = el('div', 'sm-ah-cell sm-ah-heat', strip);
    el('div', 'sm-ah-lbl', els.heatCell, 'HEAT');
    els.heat = el('div', 'sm-ah-val', els.heatCell, '0%');
    els.heatBar = el('div', 'sm-ah-mini', els.heatCell);
    el('div', 'sm-ah-mini-fill', els.heatBar);

    els.integCell = el('div', 'sm-ah-cell sm-ah-integ', strip);
    el('div', 'sm-ah-lbl', els.integCell, 'HULL');
    els.integ = el('div', 'sm-ah-val', els.integCell, '100%');
    els.integBar = el('div', 'sm-ah-mini', els.integCell);
    el('div', 'sm-ah-mini-fill', els.integBar);

    /* --- row 2: FUEL, the primary gauge -------------------------------- */
    els.fuelPanel = el('div', 'sm-panel sm-ah-fuel', els.root);
    var fhead = el('div', 'sm-ah-fuel-head', els.fuelPanel);
    el('div', 'sm-ah-lbl', fhead, 'FUEL');
    els.fuelPct = el('div', 'sm-ah-fuel-pct', fhead, '0%');
    els.fuelNote = el('div', 'sm-ah-fuel-note', fhead, '');
    var fbar = el('div', 'sm-ah-bar sm-ah-bar-fuel', els.fuelPanel);
    els.fuelFill = el('div', 'sm-ah-bar-fill', fbar);
    // The reserve MARK is the whole instrument: it turns an abstract percentage
    // into "that much is the way home". Positioned by a CSS var, never by JS.
    els.fuelMark = el('div', 'sm-ah-bar-mark', fbar);

    /* THE SUB LINE IS FOUR SPANS, NOT ONE STRING.
     * On a wide screen it reads as one sentence — HOME 5u · BURN 0.5/s · 88s
     * LEFT — which is the arithmetic the player would otherwise do in their
     * head. It will not fit in a 48 px rail, and the piece that has to survive
     * is the FIRST one: what the trip home costs. Splitting it lets the
     * stylesheet drop BURN and SECONDS LEFT on a phone and stack HOME over its
     * value, with the separators supplied by CSS ::before so an empty span
     * leaves no orphaned dot. Still one guarded write per span. */
    els.fuelSub = el('div', 'sm-ah-sub', els.fuelPanel);
    el('span', 'sm-ah-sub-k', els.fuelSub, 'HOME ');
    els.fuelHome = el('span', 'sm-ah-sub-home', els.fuelSub, '');
    els.fuelBurn = el('span', 'sm-ah-sub-burn', els.fuelSub, '');
    els.fuelLeft = el('span', 'sm-ah-sub-left', els.fuelSub, '');

    /* --- row 3: the hold ----------------------------------------------- */
    els.cargoPanel = el('div', 'sm-panel sm-ah-cargo', els.root);
    var chead = el('div', 'sm-ah-fuel-head', els.cargoPanel);
    el('div', 'sm-ah-lbl', chead, 'HOLD');
    /* "0 / 48" is two spans for the same reason as the fuel sub line: inline on
     * a wide screen, and the capacity dropped onto its own line in the rail. */
    els.cargoVal = el('div', 'sm-ah-cargo-val', chead);
    els.cargoNow = el('span', 'sm-ah-cargo-now', els.cargoVal, '0');
    els.cargoCap = el('span', 'sm-ah-cargo-cap', els.cargoVal, ' / 0');
    els.cargoWorth = el('div', 'sm-ah-fuel-note', chead, '');
    var cbar = el('div', 'sm-ah-bar sm-ah-bar-cargo', els.cargoPanel);
    els.cargoFill = el('div', 'sm-ah-bar-fill', cbar);

    /* THE MANIFEST LIVES IN A DRAWER.
     * On a wide screen the drawer is an ordinary block and the manifest is just
     * part of the stack, exactly as it always was. In the rail layout the
     * stylesheet lifts it out of the 48 px column and opens it inwards across
     * the rock on a tap — see THE HOLD DRAWER. The wrapper exists so that one
     * CSS rule moves the rows AND the "+N MORE" line together. */
    els.drawer = el('div', 'sm-ah-drawer', els.cargoPanel);
    els.manifest = el('div', 'sm-ah-manifest', els.drawer);
    els.manifestMore = el('div', 'sm-ah-more', els.drawer, '');

    /* The handle. Hidden on a wide screen, where there is nothing to unfold. */
    els.holdBtn = el('button', 'sm-ah-holdbtn', els.cargoPanel);
    els.holdBtn.setAttribute('type', 'button');
    els.holdBtn.setAttribute('title', 'Manifest — tap a row twice to dump it');
    els.holdBtn.setAttribute('aria-label', 'Manifest');
    els.holdIco = el('span', 'sm-ah-holdico', els.holdBtn);
    els.holdIco.innerHTML = glyph(ICONS.manifest);
    els.holdCount = el('span', 'sm-ah-holdnum', els.holdBtn, '0');
    els.holdBtn.addEventListener('click', function (e) {
      e.preventDefault();
      els.holdBtn.blur();
      toggleDrawer();
    }, false);

    /* --- the scanner line ----------------------------------------------- */
    els.scan = el('div', 'sm-ah-scan', els.root);
    els.scanArrow = el('div', 'sm-ah-scan-arrow', els.scan);
    els.scanArrow.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3.4v17.2"/><path d="M5.6 9.8 12 3.4l6.4 6.4"/></svg>';
    els.scanText = el('div', 'sm-ah-scan-text', els.scan, '');
    els.scanDist = el('div', 'sm-ah-scan-dist', els.scan, '');

    /* --- alert banner --------------------------------------------------- */
    els.alert = el('div', 'sm-ah-alert', els.root);
    els.alertTitle = el('div', 'sm-ah-alert-title', els.alert, '');
    els.alertSub = el('div', 'sm-ah-alert-sub', els.alert, '');

    /* --- top-right controls --------------------------------------------- */
    var btns = el('div', 'sm-ah-btns', root);
    els.btns = btns;
    /* Own class names, NOT ui.js's sm-btn-sound / sm-btn-pause: both HUDs are
     * in the DOM at the same time and a shared class would make
     * querySelector('.sm-btn-pause') a coin toss for anything that looks. */
    els.mute = iconButton(btns, 'sm-ah-sound', ICONS.sound_on, 'Sound on / off');
    els.pauseBtn = iconButton(btns, 'sm-ah-pausebtn', ICONS.pause, 'Pause');
    els.mute.addEventListener('click', function (e) {
      e.preventDefault();
      if (SM.sound && SM.sound.toggleMute) SM.sound.toggleMute();
      refreshMute();
      els.mute.blur();
    });
    els.pauseBtn.addEventListener('click', function (e) {
      e.preventDefault();
      els.pauseBtn.blur();
      openPause();
    });

    /* --- the adventure pause card ---------------------------------------
     * Deliberately a sibling of the HUD, not a child: the HUD dims behind it
     * (see .sm-ah-paused in style-adventure.css) and a dimmed parent cannot
     * hold an undimmed card. */
    els.pause = el('div', 'sm-ah-pause', root);
    var card = el('div', 'sm-panel sm-ah-pause-card', els.pause);
    el('div', 'sm-stripe', card);
    el('div', 'sm-pause-kicker', card, 'ENGINE IDLING');
    el('div', 'sm-pause-title', card, 'PAUSED');
    els.pauseStats = el('div', 'sm-ah-pause-stats', card);
    els.psDepth = statCell(els.pauseStats, 'DEPTH', '0 m');
    els.psFuel = statCell(els.pauseStats, 'FUEL', '0%');
    els.psHold = statCell(els.pauseStats, 'HOLD', '0%');

    els.btnResume = menuButton(card, 'sm-btn-primary', ICONS.play, 'RESUME');
    els.btnAbort = menuButton(card, 'sm-ah-danger', ICONS.abort, 'ABORT RUN');
    els.btnLeave = menuButton(card, '', ICONS.home, 'LEAVE EXPEDITION');
    els.abortNote = el('div', 'sm-ah-pause-note', card,
      'Aborting drops the hold where it stands, exactly like running dry.');

    els.btnResume.addEventListener('click', function (e) {
      e.preventDefault(); els.btnResume.blur(); closePause();
    });
    // ABORT and LEAVE both throw a run away, so both are two-tap.
    armConfirm(els.btnAbort, 'ABORT RUN', 'CONFIRM — LOSE THE HOLD', function () {
      closePause();
      if (SM.adv && SM.adv.abort) SM.adv.abort();
    });
    armConfirm(els.btnLeave, 'LEAVE EXPEDITION', 'CONFIRM — BACK TO MENU', function () {
      closePause();
      if (SM.adv && SM.adv.abort) SM.adv.abort();
      if (SM.adv && SM.adv.close) SM.adv.close();
    });
  }

  function statCell(parent, label, value) {
    var cell = el('div', 'sm-cell', parent);
    el('div', 'sm-cell-label', cell, label);
    return el('div', 'sm-cell-value', cell, value);
  }

  /**
   * Two-tap confirm on a destructive button. The label changes, so there is no
   * modal on top of a modal and no dialog to mis-tap through — and it re-arms
   * itself on a timer so a stale CONFIRM can never be sitting there waiting.
   */
  function armConfirm(btn, label, confirmLabel, run) {
    var armed = false, t = 0;
    var lbl = btn.querySelector('.sm-pause-label');
    function disarm() {
      armed = false;
      if (t) { clearTimeout(t); t = 0; }
      btn.classList.remove('sm-ah-armed');
      if (lbl) lbl.textContent = label;
    }
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      btn.blur();
      if (!armed) {
        armed = true;
        btn.classList.add('sm-ah-armed');
        if (lbl) lbl.textContent = confirmLabel;
        if (SM.sound && SM.sound.play) SM.sound.play('ui');
        t = setTimeout(disarm, 3200);
        return;
      }
      disarm();
      run();
    }, false);
    btn.smDisarm = disarm;
  }

  function refreshMute() {
    if (!els.mute) return;
    var muted = !!(SM.sound && SM.sound.isMuted && SM.sound.isMuted());
    els.mute.innerHTML = glyph(muted ? ICONS.sound_off : ICONS.sound_on);
    setClass('mute', els.mute, 'sm-btn-off', muted);
  }

  /* =====================================================================
   * PAUSE
   * ================================================================== */
  function openPause() {
    if (pauseOpen || !visible) return;
    // main.js returns the RESULTING state, so a refused pause is visible on
    // the spot. Only an explicit false is a refusal; a partial merge that
    // returns nothing must still get a working card.
    if (SM.main && SM.main.setPaused && SM.main.setPaused(true) === false) return;
    pauseOpen = true;
    if (SM.joystick && SM.joystick.reset) SM.joystick.reset();   // never freeze mid-push
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
    els.pause.classList.add('sm-ah-pause-on');
    els.root.classList.add('sm-ah-paused');
    paintPauseStats();
  }

  function closePause(silent) {
    if (!pauseOpen) return;
    pauseOpen = false;
    if (els.btnAbort && els.btnAbort.smDisarm) els.btnAbort.smDisarm();
    if (els.btnLeave && els.btnLeave.smDisarm) els.btnLeave.smDisarm();
    if (silent !== true && SM.sound && SM.sound.play) SM.sound.play('ui');
    if (SM.main && SM.main.setPaused) SM.main.setPaused(false);
    els.pause.classList.remove('sm-ah-pause-on');
    els.root.classList.remove('sm-ah-paused');
  }

  function paintPauseStats() {
    var a = A();
    if (!a) return;
    setText('psd', els.psDepth, fmt(num(a.getDepthM && a.getDepthM(), 0)) + ' m');
    setText('psf', els.psFuel, Math.round(num(a.getFuelPct && a.getFuelPct(), 0) * 100) + '%');
    setText('psh', els.psHold, Math.round(num(a.getCargoPct && a.getCargoPct(), 0) * 100) + '%');
  }

  /**
   * ESC / P. ui.js owns the same keys but refuses to act while adventure is
   * active (canPause() returns false) and returns WITHOUT preventDefault, so
   * this listener is the only one that answers them underground.
   */
  function onKeyDown(e) {
    if (!e || !visible) return;
    var k = e.key;
    if (k === 'Escape' || k === 'Esc' || k === 'p' || k === 'P') {
      e.preventDefault();
      if (pauseOpen) closePause(); else openPause();
    }
  }

  /** Somebody else paused us. Mirror it; never call setPaused() back. */
  function onGamePaused(p) {
    var on = !!(p && p.paused);
    if (!visible || on === pauseOpen) return;
    if (on) openPause(); else closePause(true);
  }

  /* =====================================================================
   * THE HOLD DRAWER
   * ---------------------------------------------------------------------
   * The manifest may collapse on a phone; it may not disappear. The FILL LEVEL
   * is what you steer by and it is never hidden — bar, units and worth are all
   * on the rail. The MANIFEST is different: it is only needed at the one moment
   * you decide to tip the coal out, so it hides behind the count button at the
   * foot of the rail and opens inwards over the rock when asked.
   *
   * The state is a single class on the wrapper. On a wide screen the drawer is
   * always open because the stylesheet never closes it, so the class is inert
   * there and a resize between the two layouts needs no bookkeeping.
   * ================================================================== */
  var drawerOpen = false;

  function paintDrawer() {
    setClass('drawon', els.drawer, 'sm-ah-drawer-on', drawerOpen);
    setClass('drawbtn', els.holdBtn, 'sm-ah-holdbtn-on', drawerOpen);
  }

  function toggleDrawer() {
    drawerOpen = !drawerOpen;
    // Closing it must also disarm a pending DUMP, or the confirm is sitting
    // there behind a shut door waiting for a tap that means something else now.
    if (!drawerOpen && dumpArmed >= 0) {
      dumpArmed = -1;
      dumpTimer = 0;
      paintDumpArm();
    }
    paintDrawer();
    if (SM.sound && SM.sound.play) SM.sound.play('ui');
  }

  /* =====================================================================
   * THE MANIFEST
   * ---------------------------------------------------------------------
   * Rows are pooled and only rebuilt when the SIGNATURE of the hold changes,
   * which is checked on the slow timer — walking the manifest array is the
   * one thing in this file that is not O(1), so it does not happen 60 times a
   * second.
   * ================================================================== */
  function manifestRow(i) {
    var r = manifestRows[i];
    if (r) return r;
    var node = el('button', 'sm-ah-mrow', els.manifest);
    node.setAttribute('type', 'button');
    r = {
      node: node,
      sw: el('span', 'sm-ah-msw', node),
      name: el('span', 'sm-ah-mname', node, ''),
      units: el('span', 'sm-ah-munits', node, ''),
      val: el('span', 'sm-ah-mval', node, ''),
      matIndex: -1
    };
    node.addEventListener('click', function (e) {
      e.preventDefault();
      node.blur();
      onDumpTap(r);
    }, false);
    manifestRows[i] = r;
    return r;
  }

  /**
   * Tap a row to dump it, twice to mean it. A hold full of coal in front of a
   * gold seam is the best decision the mode offers and it has to be makeable
   * without opening anything — but one stray tap must never bin the gold.
   */
  function onDumpTap(r) {
    if (r.matIndex < 0) return;
    if (dumpArmed !== r.matIndex) {
      dumpArmed = r.matIndex;
      dumpTimer = DUMP_CONFIRM;
      paintDumpArm();
      if (SM.sound && SM.sound.play) SM.sound.play('ui');
      return;
    }
    dumpArmed = -1;
    dumpTimer = 0;
    paintDumpArm();
    if (SM.adv && SM.adv.dump) SM.adv.dump(r.matIndex);
    alert('JETTISONED', String(r.name.textContent || '') + ' tipped onto the floor', 1.8);
  }

  function paintDumpArm() {
    for (var i = 0; i < manifestRows.length; i++) {
      var r = manifestRows[i];
      if (!r) continue;
      var on = (r.matIndex >= 0 && r.matIndex === dumpArmed);
      setClass('darm' + i, r.node, 'sm-ah-mrow-armed', on);
      // SAME cache key as refreshManifest() writes with, or the two would
      // shadow each other and leave a row stuck reading DUMP?.
      setText('mu' + i, r.units, on ? 'DUMP?' : (r.unitsText || ''));
    }
  }

  function refreshManifest() {
    var a = A();
    var list = (a && a.getManifest) ? a.getManifest() : null;
    if (!list || typeof list.length !== 'number') list = [];

    // Cheapest honest change-detector: index + units of every line.
    var sig = '', i, ln;
    for (i = 0; i < list.length; i++) {
      ln = list[i];
      if (!ln) continue;
      sig += (ln.matIndex === undefined ? ln.matId : ln.matIndex) + ':' + Math.round(num(ln.units, 0)) + '|';
    }
    if (sig === manifestSig) return;
    manifestSig = sig;

    var shown = Math.min(list.length, MANIFEST_ROWS);
    var hiddenUnits = 0, worth = 0;

    // Richest last in the source array, so the HUD walks it backwards: the
    // line worth protecting is the first one the eye lands on.
    var used = 0;
    for (i = list.length - 1; i >= 0; i--) {
      ln = list[i];
      if (!ln) continue;
      worth += num(ln.value, 0);
      if (used >= shown) { hiddenUnits += num(ln.units, 0); continue; }
      var idx = used++;
      var r = manifestRow(idx);
      var d = displayOf(ln.matIndex, ln.matId);
      r.matIndex = (typeof ln.matIndex === 'number') ? ln.matIndex : -1;
      r.node.style.display = '';
      setVar('msw' + idx, r.sw, '--sm-ah-sw', d.color);
      setText('mn' + idx, r.name, d.name.toUpperCase());
      r.unitsText = fmt(num(ln.units, 0)) + 'u';
      setText('mu' + idx, r.units, (r.matIndex === dumpArmed) ? 'DUMP?' : r.unitsText);
      setText('mv' + idx, r.val, num(ln.value, 0) > 0 ? ('$' + fmt(ln.value)) : '—');
    }
    for (i = used; i < manifestRows.length; i++) {
      if (manifestRows[i]) {
        manifestRows[i].node.style.display = 'none';
        manifestRows[i].matIndex = -1;
      }
    }

    setText('mmore', els.manifestMore,
            hiddenUnits > 0 ? ('+ ' + fmt(hiddenUnits) + 'u OF OTHER MATERIAL') : '');
    setClass('mmoreon', els.manifestMore, 'sm-ah-more-on', hiddenUnits > 0);
    setText('mworth', els.cargoWorth, worth > 0 ? ('$' + fmt(worth)) : '');
    setClass('mempty', els.manifest, 'sm-ah-manifest-empty', used === 0);
    /* The drawer handle says how many DIFFERENT materials are aboard, which is
     * the number that decides whether opening it is worth a tap. It is written
     * here, on the slow timer, because it is a by-product of the one array walk
     * this file does — never a separate count. */
    setText('hnum', els.holdCount, '' + used);
    setClass('hbempty', els.holdBtn, 'sm-ah-holdbtn-empty', used === 0);
  }

  /* =====================================================================
   * THE SCANNER LINE
   * ================================================================== */
  function refreshScanner() {
    var s = SM.scanner;
    var best = (s && s.isEnabled && s.isEnabled() && s.getBest) ? s.getBest() : null;
    setClass('scanon', els.scan, 'sm-ah-scan-on', !!best);
    if (!best) return;

    var d = displayOf(best.matIndex, best.matId);
    setText('scant', els.scanText, (d.name || 'SIGNATURE').toUpperCase() + ' SIGNATURE');
    var dist = num(best.dist, 0) * M_PER_UNIT;
    setText('scand', els.scanDist, Math.round(dist) + ' m');
    // bearing is radians, 0 = straight down the shaft the machine is facing.
    var deg = Math.round(num(best.bearing, 0) * 180 / Math.PI);
    setVar('scanb', els.scanArrow, '--sm-ah-bearing', deg + 'deg');
    setVar('scanc', els.scan, '--sm-ah-sw', d.color);
  }

  /* =====================================================================
   * ALERTS — the short banner
   * ================================================================== */
  /** A short banner: 'CARGO FULL', 'FUEL RESERVE', 'UNKNOWN SIGNATURE'. */
  function alert(title, sub, seconds) {
    if (!built || !els.alert) return;
    els.alertTitle.textContent = title || '';
    els.alertSub.textContent = sub || '';
    retrigger(els.alert, 'sm-ah-alert-on');
    alertTimer = seconds || ALERT_TIME;
  }

  /** Rate-limited alert, one clock per kind. Events underground are bursty. */
  function alertKind(kind, title, sub, seconds) {
    if (alertClock[kind] !== undefined && alertClock[kind] < ALERT_GAP) return;
    alertClock[kind] = 0;
    alert(title, sub, seconds);
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    if (!built) build();
    if (!subscribed) {
      subscribed = true;
      /* The HUD (and the joystick with it) follows the state machine rather
       * than waiting to be told: adv.js may well call show()/hide() as well,
       * and both are idempotent, so whichever arrives first wins and the
       * other is free. */
      SM.events.on('adv:state', onState);
      SM.events.on('game:paused', onGamePaused);
      SM.events.on('sound:muted', refreshMute);
      SM.events.on('adv:cargofull', function () {
        alertKind('full', 'HOLD FULL', 'Dump the spoil or head for the surface', 2.6);
      });
      SM.events.on('adv:fuellow', function (p) {
        var pct = Math.round(num(p && p.pct, 0) * 100);
        alertKind('fuel', 'FUEL LOW', pct + '% left  ·  check the reserve mark', 2.8);
      });
      SM.events.on('adv:damage', function (p) {
        alertKind('dmg', 'HULL DAMAGE', String((p && p.source) || 'impact').toUpperCase(), 1.8);
      });
      SM.events.on('adv:heat', function (p) {
        if (num(p && p.pct, 0) < 0.9) return;
        alertKind('heat', 'OVERHEATING', 'Back off the rock and let it cool', 2.2);
      });
      SM.events.on('mine:layer', function (p) {
        if (!p || !p.name) return;
        alertKind('layer', String(p.name).toUpperCase(),
                  Math.round(num(p.depthM, 0)) + ' m  ·  new stratum', 2.2);
      });
      SM.events.on('scan:contact', function (p) {
        if (!p) return;
        var d = displayOf(p.matIndex, p.matId);
        alertKind('scan', (d.name || 'ORE').toUpperCase() + ' SIGNATURE',
                  Math.round(num(p.dist, 0) * M_PER_UNIT) + ' m away', 2.0);
      });
      /* THE MOTHERLODE. advterrain.js fires this when a real formation comes
       * into range, and it is the moment the whole mode is built to deliver —
       * so it gets the one piece of celebration the in-mine HUD has: its own
       * banner treatment and a warm flash across the rock. */
      SM.events.on('mine:lode', function (p) {
        if (!p) return;
        var d = displayOf(p.matIndex, p.matId);
        var dist = Math.round(num(p.dist, 0) * M_PER_UNIT);
        alertKind('lode', 'MOTHERLODE  ·  ' + (d.name || 'ORE').toUpperCase(),
                  dist > 0 ? (dist + ' m — fill the hold') : 'Fill the hold', 3.2);
        setClass('lode', els.alert, 'sm-ah-alert-lode', true);
        lodeHold = 3.2;
        if (SM.effects && SM.effects.screenFlash) SM.effects.screenFlash(0.16, 255, 214, 120);
        if (SM.sound && SM.sound.play) SM.sound.play('ui');
      });
      window.addEventListener('keydown', onKeyDown, false);
      window.addEventListener('blur', function () {
        if (els.btnAbort && els.btnAbort.smDisarm) els.btnAbort.smDisarm();
      }, false);
    }
    refreshMute();
  }

  function onState(p) {
    var st = (p && p.state) || (SM.adv && SM.adv.getState ? SM.adv.getState() : 'off');
    if (st === 'mine') {
      show();
      if (SM.joystick && SM.joystick.show) SM.joystick.show();
    } else {
      hide();
      if (SM.joystick && SM.joystick.hide) SM.joystick.hide();
    }
  }

  /** Build/attach and reveal. Called when a descent begins. */
  function show() {
    if (!built) build();
    if (!els.root || visible) return;
    visible = true;
    reset();
    els.root.classList.add('sm-ah-on');
    els.btns.classList.add('sm-ah-on');
    refreshMute();
  }

  function hide() {
    if (!built) return;
    visible = false;
    closePause(true);
    els.root.classList.remove('sm-ah-on');
    els.btns.classList.remove('sm-ah-on');
  }

  function reset() {
    last = {};
    manifestSig = ' ';       // not '' — an empty hold must still repaint
    alertTimer = 0;
    alertClock = {};
    lodeHold = 0;
    dumpArmed = -1;
    dumpTimer = 0;
    slowTimer = 0;
    if (els.alert) els.alert.classList.remove('sm-ah-alert-on');
    // A fresh descent starts with the drawer shut over a clear view of the
    // shaft. paintDrawer() runs AFTER last = {} above, so the write lands.
    drawerOpen = false;
    paintDrawer();
  }

  /* =====================================================================
   * UPDATE — inside the fixed step. Read the rules at the top of the file.
   * ================================================================== */
  function update(dt) {
    if (!visible || !built) return;
    var a = A();
    if (!a) return;

    /* --- timers ------------------------------------------------------- */
    if (alertTimer > 0) {
      alertTimer -= dt;
      if (alertTimer <= 0) els.alert.classList.remove('sm-ah-alert-on');
    }
    if (lodeHold > 0) {
      lodeHold -= dt;
      if (lodeHold <= 0) setClass('lode', els.alert, 'sm-ah-alert-lode', false);
    }
    for (var k in alertClock) if (alertClock.hasOwnProperty(k)) alertClock[k] += dt;
    if (dumpArmed >= 0) {
      dumpTimer -= dt;
      if (dumpTimer <= 0) { dumpArmed = -1; paintDumpArm(); }
    }

    /* --- depth, and the company balance -------------------------------- */
    var depth = num(a.getDepthM && a.getDepthM(), 0);
    setText('depth', els.depth, fmt(depth) + ' m');
    /* Was TO SURFACE, which is the same number as DEPTH — the mouth is depth 0.
     *
     * The save record is a FALLBACK on purpose. Every other reading here comes
     * from one place, but a stale cached adv.js that predates getCash() would
     * make this the only gauge on the panel silently pinned to $0, and the
     * company balance is also written on the record, so there is a second
     * source available for free. */
    var cashNow = num(a.getCash && a.getCash(), -1);
    if (cashNow < 0) {
      var rec = (SM.save && SM.save.get) ? SM.save.get() : null;
      cashNow = num(rec && rec.cash, 0);
    }
    setText('funds', els.funds, '$' + fmt(cashNow));

    /* --- FUEL, the gauge the whole mode turns on ----------------------- */
    var cap = num(a.getFuelCap && a.getFuelCap(), 1);
    if (cap <= 0) cap = 1;
    var fuel = num(a.getFuel && a.getFuel(), 0);
    var pct = num(a.getFuelPct && a.getFuelPct(), fuel / cap);
    if (pct < 0) pct = 0; else if (pct > 1) pct = 1;
    var reserve = num(a.getReserveNeeded && a.getReserveNeeded(), 0);
    var burn = num(a.getBurnRate && a.getBurnRate(), 0);

    setText('fpct', els.fuelPct, Math.round(pct * 100) + '%');
    setVar('ffill', els.fuelFill, '--sm-ah-fill', pct.toFixed(3));
    var resFrac = reserve / cap;
    if (resFrac < 0) resFrac = 0; else if (resFrac > 1) resFrac = 1;
    setVar('fmark', els.fuelMark, '--sm-ah-mark', resFrac.toFixed(3));
    setClass('fmarkon', els.fuelMark, 'sm-ah-bar-mark-on', reserve > 0);

    var crit = (reserve > 0 && fuel <= reserve * CRIT_MARGIN) || pct <= 0.06;
    var warnState = !crit && ((reserve > 0 && fuel <= reserve * WARN_MARGIN) || pct <= LOW_PCT);
    setClass('fwarn', els.fuelPanel, 'sm-ah-warn', warnState);
    setClass('fcrit', els.fuelPanel, 'sm-ah-crit', crit);
    setText('fnote', els.fuelNote,
            crit ? 'RESERVE SPENT' : (warnState ? 'TURN BACK' : ''));

    // The sub line is the arithmetic the player would otherwise do in their
    // head: what the trip home costs, and how long the tank lasts at this draw.
    // Three writes rather than one string, so the rail can keep the first part
    // and drop the rest — the separators come from CSS (see build()).
    setText('fhome', els.fuelHome, fmt(reserve) + 'u');
    setText('fburn', els.fuelBurn, burn > 0.001 ? ('BURN ' + burn.toFixed(1) + '/s') : '');
    setText('fleft', els.fuelLeft, burn > 0.001 ? (Math.round(fuel / burn) + 's LEFT') : '');

    /* --- the hold ------------------------------------------------------ */
    var ccap = num(a.getCargoCap && a.getCargoCap(), 1);
    if (ccap <= 0) ccap = 1;
    var cargo = num(a.getCargo && a.getCargo(), 0);
    var cpct = num(a.getCargoPct && a.getCargoPct(), cargo / ccap);
    if (cpct < 0) cpct = 0; else if (cpct > 1) cpct = 1;
    setText('cnow', els.cargoNow, fmt(cargo));
    setText('ccap', els.cargoCap, ' / ' + fmt(ccap));
    setVar('cfill', els.cargoFill, '--sm-ah-fill', cpct.toFixed(3));
    setClass('cfull', els.cargoPanel, 'sm-ah-full', cpct > 0.995);

    /* --- heat and integrity: absent until they matter ------------------ */
    var hpct = num(a.getHeatPct && a.getHeatPct(), 0);
    var heatLive = hpct > HEAT_SHOW;
    setClass('hon', els.heatCell, 'sm-ah-live', heatLive);
    if (heatLive) {
      setText('hval', els.heat, Math.round(hpct * 100) + '%');
      setVar('hfill', els.heatBar, '--sm-ah-fill', hpct.toFixed(3));
      setClass('hhot', els.heatCell, 'sm-ah-hot', hpct > 0.8);
    }
    /* HULL IS ALWAYS ON SHOW, even at 100%.
     * It used to appear only once damaged, on the same "no dead gauges" rule as
     * HEAT. That reasoning does not hold for the hull: unlike heat, it does not
     * reset between descents, repairing it costs money at the surface, and going
     * down at 100% is a materially different proposition from going down at 40%.
     * A player needs to be able to check it BEFORE it becomes a problem, and a
     * gauge that only exists once you are already in trouble cannot be checked. */
    var integ = num(a.getIntegrity && a.getIntegrity(), 1);
    setClass('ion', els.integCell, 'sm-ah-live', true);
    setText('ival', els.integ, Math.round(integ * 100) + '%');
    setVar('ifill', els.integBar, '--sm-ah-fill', integ.toFixed(3));
    setClass('ihot', els.integCell, 'sm-ah-hot', integ < 0.35);

    /* --- the array walkers, on their own clock ------------------------- */
    slowTimer += dt;
    if (slowTimer >= 1 / SLOW_HZ) {
      slowTimer = 0;
      refreshManifest();
      refreshScanner();
      if (pauseOpen) paintPauseStats();
    }
  }

  function isVisible() { return visible; }
  function isPaused() { return pauseOpen; }

  return {
    init: init,
    show: show,
    hide: hide,
    reset: reset,
    update: update,
    isVisible: isVisible,
    alert: alert,
    /* --- additions ---------------------------------------------------- */
    isPaused: isPaused,
    openPause: openPause,
    closePause: closePause
  };
})();
