/* =============================================================================
 * SUPERMINE — js/joystick.js                       [OWNER: Agent 4 — INTERFACE]
 * -----------------------------------------------------------------------------
 * THE TRANSLUCENT THUMBSTICK. This is the headline control change of adventure
 * mode: the machine no longer drives itself, and left/right is no longer the
 * whole vocabulary. The player points, the machine goes.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A DOM LAYER AND NOT CANVAS
 *   js/input.js's canvas pointer handler ignores any event whose target is not
 *   the canvas itself — that is how the existing HUD buttons coexist with drag
 *   steering. A full-bleed DOM layer therefore takes pointers cleanly, with no
 *   change to a frozen file and no double-handling. It also means the stick can
 *   be pure CSS: two circles, a transform, and a transition.
 *
 * THE ONE THING IT DOES
 *   Convert pointer position into a unit vector and push it:
 *       SM.input.setStick(x, y)        // -1..1 each, magnitude clamped to 1
 *       SM.input.clearStick()          // on release/cancel — CENTRES the stick
 *   Nothing else in the codebase reads this module. It is an input device.
 *
 * HOW IT WORKS, AND WHY IT IS BUILT THIS WAY
 *   POINTERDOWN ON THE LAYER, MOVE AND UP ON THE WINDOW. Exactly the split
 *   js/input.js already uses for drag steering. Pointer capture is requested as
 *   well, but it is a bonus, not the mechanism: capture throws on a synthetic
 *   pointerId (which is how this module is tested) and is silently dropped by
 *   some engines mid-gesture, and neither may be allowed to strand a held
 *   stick. Listening at the window means the release ALWAYS arrives.
 *
 *   FLOATING ORIGIN. The base materialises under the thumb wherever it lands.
 *   There is no fixed circle to find while looking at the mine.
 *
 *   DEAD ZONE, then a RESCALE. Inside DEAD_ZONE the stick reads exactly zero,
 *   so a resting thumb cannot creep the machine into a wall and burn fuel.
 *   Outside it the remaining travel is stretched back over the full 0..1
 *   range, or the first 16% of every push would be a step change.
 *
 *   RIM CLAMP WITH A RE-ANCHORING BASE. Past the rim the knob stops and the
 *   base slides after the finger, so you never run out of screen — the same
 *   mechanic input.js already tuned for the classic drag rail.
 *
 *   MULTI-TOUCH SAFE. One pointerId owns the stick for the whole gesture. A
 *   second finger on a HUD button cannot steal it and its release cannot
 *   cancel it.
 *
 *   NEVER NAG A KEYBOARD PLAYER. The layer is armed the moment a descent
 *   begins but the stick itself does not paint until a pointer actually uses
 *   it; WASD/arrows already feed the same vector inside input.js.
 *
 *   RELEASE ALWAYS CENTRES. A stick left deflected by a lost pointer (an
 *   incoming call, a browser back-gesture, a tab switch) would drive the
 *   machine into the dark until the tank ran dry. pointerup, pointercancel,
 *   lostpointercapture, window blur and visibilitychange all funnel into one
 *   idempotent release().
 * ========================================================================== */

var SM = SM || {};

SM.joystick = (function () {
  'use strict';

  /* ----- Agent-4 tunables live here -----------------------------------
   * RADIUS is the throw in CSS pixels: the distance from the base centre that
   * means "full speed". 74 px is about a comfortable thumb rotation on a phone
   * and is deliberately SMALLER than input.js's 170 px steering rail — that
   * rail is a one-dimensional wheel you saw at, this is a stick you hold. */
  var RADIUS      = 74;      // px of travel that equals full deflection
  var DEAD_ZONE   = 0.16;    // fraction of RADIUS read as neutral
  var KNOB_R      = 30;      // px, visual only (must match style-adventure.css)
  var HIDE_DELAY  = 900;     // ms the base lingers after release before fading

  /* ------------------------------------------------------------------ */

  var layer = null;          // full-bleed pointer surface
  var base = null;           // the ring that anchors under the thumb
  var knob = null;
  var built = false;
  var visible = false;       // the LAYER is armed (a descent is running)
  var painted = false;       // the STICK has been shown at least once
  var bound = false;

  var activeId = -1;         // pointerId that owns the stick, -1 = none
  var originX = 0, originY = 0;
  var vecX = 0, vecY = 0;
  var hideTimer = 0;

  // Last transforms written, so a 120 Hz pointermove stream does not write
  // identical strings to the style object twice in a row.
  var lastBase = '';
  var lastKnob = '';

  /* =====================================================================
   * BUILD
   * ================================================================== */
  function build() {
    var root = document.getElementById('ui-root');
    if (!root) return;

    /* position:fixed rather than absolute: #ui-root carries the safe-area
     * padding, and an input surface wants the WHOLE viewport so client
     * coordinates map straight through with no rect measuring. */
    layer = document.createElement('div');
    layer.className = 'sm-stick-layer';

    base = document.createElement('div');
    base.className = 'sm-stick-base';
    var ring = document.createElement('div');
    ring.className = 'sm-stick-ring';
    base.appendChild(ring);
    knob = document.createElement('div');
    knob.className = 'sm-stick-knob';
    base.appendChild(knob);
    layer.appendChild(base);
    root.appendChild(layer);
    built = true;

    layer.addEventListener('pointerdown', onDown, { passive: false });
    layer.addEventListener('contextmenu', function (e) { e.preventDefault(); }, false);
    // touchstart/touchmove are swallowed so iOS cannot turn a drive into a
    // page scroll or a double-tap zoom. The canvas already does this; the
    // stick layer sits on top of it and has to do it for itself.
    layer.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    layer.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
  }

  function bindGlobal() {
    if (bound) return;
    bound = true;
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp, false);
    window.addEventListener('pointercancel', onUp, false);
    window.addEventListener('lostpointercapture', onUp, false);
    window.addEventListener('blur', release, false);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) release();
    }, false);
  }

  /* =====================================================================
   * THE VECTOR
   * ================================================================== */
  function push(x, y) {
    vecX = x; vecY = y;
    if (SM.input && SM.input.setStick) SM.input.setStick(x, y);
  }

  /** Idempotent. Every "the finger is gone" path ends up here. */
  function release() {
    if (activeId !== -1 && layer && layer.releasePointerCapture) {
      try { layer.releasePointerCapture(activeId); } catch (e) { /* already gone */ }
    }
    activeId = -1;
    vecX = 0; vecY = 0;
    if (SM.input && SM.input.clearStick) SM.input.clearStick();
    if (knob) {
      lastKnob = 'translate(-50%,-50%)';
      knob.style.transform = lastKnob;
    }
    if (base) base.classList.remove('sm-stick-hold');
    // Let the base linger for a beat, then fade. Snapping it away the instant
    // a thumb lifts makes a series of small corrections look like a strobe.
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    if (painted) {
      hideTimer = setTimeout(function () {
        hideTimer = 0;
        if (activeId === -1 && base) base.classList.remove('sm-stick-on');
      }, HIDE_DELAY);
    }
  }

  function moveBase(x, y) {
    var t = 'translate(' + (x | 0) + 'px,' + (y | 0) + 'px)';
    if (t === lastBase) return;
    lastBase = t;
    base.style.transform = t;
  }

  function moveKnob(dx, dy) {
    var t = 'translate(-50%,-50%) translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    if (t === lastKnob) return;
    lastKnob = t;
    knob.style.transform = t;
  }

  /* =====================================================================
   * POINTER HANDLERS
   * ================================================================== */
  function onDown(e) {
    if (!visible) return;
    if (activeId !== -1) return;              // one pointer owns the stick
    activeId = (e.pointerId === undefined) ? 1 : e.pointerId;
    originX = e.clientX;
    originY = e.clientY;

    if (hideTimer) { clearTimeout(hideTimer); hideTimer = 0; }
    painted = true;
    moveBase(originX, originY);
    moveKnob(0, 0);
    base.classList.add('sm-stick-on');
    base.classList.add('sm-stick-hold');

    // A press is neutral until it moves: setStick(0,0) marks the stick ACTIVE
    // (isStickActive() is how the rest of the game knows a thumb is down)
    // without nudging the machine.
    push(0, 0);

    // Capture is a nice-to-have. It throws on a synthetic pointerId, which is
    // exactly what the smoke test dispatches, so it must never be load-bearing.
    if (layer.setPointerCapture && e.pointerId !== undefined) {
      try { layer.setPointerCapture(e.pointerId); } catch (err) { /* optional */ }
    }
    if (SM.input && SM.input.noteGesture) SM.input.noteGesture();
    if (e.preventDefault) e.preventDefault();
  }

  function onMove(e) {
    if (activeId === -1) return;
    var id = (e.pointerId === undefined) ? 1 : e.pointerId;
    if (id !== activeId) return;              // a second finger elsewhere

    var dx = e.clientX - originX;
    var dy = e.clientY - originY;
    var d = Math.sqrt(dx * dx + dy * dy);

    if (d > RADIUS) {
      // Rim: clamp the knob and slide the base after the finger, so the
      // gesture can keep going forever without running out of glass.
      var k = RADIUS / d;
      originX = e.clientX - dx * k;
      originY = e.clientY - dy * k;
      dx *= k; dy *= k;
      d = RADIUS;
      moveBase(originX, originY);
    }

    moveKnob(dx, dy);

    var m = d / RADIUS;
    if (m <= DEAD_ZONE) {
      push(0, 0);
    } else {
      // Rescale the live band back over 0..1 so the first push past the dead
      // zone is a crawl, not a lurch.
      var s = ((m - DEAD_ZONE) / (1 - DEAD_ZONE)) / d;
      push(dx * s, dy * s);
    }
    if (e.preventDefault) e.preventDefault();
  }

  function onUp(e) {
    if (activeId === -1) return;
    var id = (e && e.pointerId !== undefined) ? e.pointerId : activeId;
    // pointercancel can arrive with a different id on some engines; treat any
    // cancel as ours rather than risk a stuck stick.
    if (id !== activeId && e && e.type !== 'pointercancel') return;
    release();
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    if (!built) build();
    bindGlobal();
  }

  /** Mount and arm the layer. Called when a descent begins. */
  function show() {
    if (!built) build();
    if (!layer) return;
    visible = true;
    painted = false;
    layer.classList.add('sm-stick-armed');
    // A fresh descent starts from neutral, and the stick starts unpainted so a
    // keyboard player is never shown a thumb control they did not ask for.
    if (base) base.classList.remove('sm-stick-on');
    release();
  }

  function hide() {
    visible = false;
    if (layer) layer.classList.remove('sm-stick-armed');
    if (base) base.classList.remove('sm-stick-on');
    release();                                 // ALWAYS clear on the way out
  }

  /** Release any held pointer and centre, without unmounting. */
  function reset() { release(); }

  function isVisible() { return visible; }
  /** True while a pointer is actually driving the stick. */
  function isActive() { return activeId !== -1; }

  /* --- additions ------------------------------------------------------ */
  /** The live vector, for tests and diagnostics. Do not drive off this. */
  function getX() { return vecX; }
  function getY() { return vecY; }
  /** The throw in px, so a future settings screen can expose it. */
  function getRadius() { return RADIUS; }
  function setRadius(px) { if (px > 20 && px < 400) RADIUS = px; }

  return {
    init: init,
    show: show,
    hide: hide,
    reset: reset,
    isVisible: isVisible,
    isActive: isActive,
    getX: getX,
    getY: getY,
    getRadius: getRadius,
    setRadius: setRadius
  };
})();
