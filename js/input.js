/* =============================================================================
 * SUPERMINE — js/input.js
 * -----------------------------------------------------------------------------
 * Keyboard (A/D + arrows), mouse drag and touch drag, unified into one
 * steering axis.
 *
 * >>> THIS FILE IS FROZEN after Phase 1. <<<
 *
 * Public API
 *   SM.input.init(canvas)      -- attach listeners (called by main.js)
 *   SM.input.update(dt)        -- smooth the keyboard axis (called by main.js)
 *   SM.input.getSteer()        -- -1 (full left) .. +1 (full right)
 *   SM.input.isPointerDown()   -- true while a drag is active
 *   SM.input.reset()           -- clear all held state (used on run reset)
 *   SM.input.consumeFirstGesture() -- returns true exactly once, after the very
 *                                 first real user gesture. sound.js uses this
 *                                 to unlock WebAudio; anyone may listen to the
 *                                 'input:firstgesture' event instead.
 *
 * Behaviour notes
 *  - Pointer drag is RELATIVE and self-recentring: the anchor follows the
 *    pointer once you saturate the axis, so you can keep steering without
 *    running out of screen. Releasing snaps the axis back to neutral.
 *  - Keyboard always WINS over pointer while a key is held, so a stuck drag
 *    can never lock you out.
 * ========================================================================== */

var SM = SM || {};

SM.input = (function () {
  'use strict';

  var C = SM.config;

  var keyLeft = false;
  var keyRight = false;
  var keyAxis = 0;          // smoothed -1..1 from the keyboard

  /* --- ADVENTURE: the second axis + the virtual stick -------------------
   * Classic SUPERMINE needs one number (steer). Adventure mode drives in two
   * dimensions, so W/S and Up/Down feed a vertical twin of `keyAxis`, and
   * js/joystick.js pushes the translucent thumbstick in through setStick().
   * getSteer() is DELIBERATELY untouched — classic mode must behave exactly
   * as it did before adventure mode existed.
   * ------------------------------------------------------------------ */
  var keyUp = false;
  var keyDown = false;
  var keyAxisY = 0;         // smoothed -1..1, negative = towards the surface

  var stickX = 0, stickY = 0, stickOn = false;
  var moveVec = { x: 0, y: 0, mag: 0 };   // REUSED — never stash this object

  var pointerActive = false;
  var pointerId = -1;
  var anchorX = 0;
  var pointerAxis = 0;      // -1..1 from drag

  var firstGestureFired = false;
  var firstGesturePending = false;

  var boundCanvas = null;

  /* ------------------------------------------------------------------ */

  function noteGesture() {
    if (firstGestureFired) return;
    firstGestureFired = true;
    firstGesturePending = true;
    SM.events.emit('input:firstgesture', null);
  }

  /** Returns true exactly once — the first time it is polled after a gesture. */
  function consumeFirstGesture() {
    if (firstGesturePending) { firstGesturePending = false; return true; }
    return false;
  }

  /* --- keyboard ------------------------------------------------------ */

  function onKeyDown(e) {
    var k = e.key;
    if (k === 'a' || k === 'A' || k === 'ArrowLeft') { keyLeft = true; noteGesture(); e.preventDefault(); }
    else if (k === 'd' || k === 'D' || k === 'ArrowRight') { keyRight = true; noteGesture(); e.preventDefault(); }
    else if (k === 'w' || k === 'W' || k === 'ArrowUp') { keyUp = true; noteGesture(); e.preventDefault(); }
    else if (k === 's' || k === 'S' || k === 'ArrowDown') { keyDown = true; noteGesture(); e.preventDefault(); }
    else if (k === 'r' || k === 'R') { noteGesture(); SM.events.emit('input:restart', null); }
    else if (k === 'm' || k === 'M') { noteGesture(); SM.events.emit('input:mutetoggle', null); }
  }

  function onKeyUp(e) {
    var k = e.key;
    if (k === 'a' || k === 'A' || k === 'ArrowLeft') keyLeft = false;
    else if (k === 'd' || k === 'D' || k === 'ArrowRight') keyRight = false;
    else if (k === 'w' || k === 'W' || k === 'ArrowUp') keyUp = false;
    else if (k === 's' || k === 'S' || k === 'ArrowDown') keyDown = false;
  }

  function onBlur() { reset(); }

  /* --- pointer (mouse + touch + pen via Pointer Events) --------------- */

  function onPointerDown(e) {
    // Ignore clicks that land on DOM UI (buttons live above the canvas).
    if (e.target && e.target !== boundCanvas) return;
    if (pointerActive) return;
    pointerActive = true;
    pointerId = e.pointerId;
    anchorX = e.clientX;
    pointerAxis = 0;
    noteGesture();
    if (boundCanvas && boundCanvas.setPointerCapture) {
      try { boundCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!pointerActive || e.pointerId !== pointerId) return;
    var dx = e.clientX - anchorX;
    var range = C.INPUT_DRAG_RANGE;
    var a = dx / range;
    if (a > 1) { a = 1; anchorX = e.clientX - range; }        // re-anchor at the rail
    else if (a < -1) { a = -1; anchorX = e.clientX + range; }
    pointerAxis = a;
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (!pointerActive || (e.pointerId !== pointerId && e.type !== 'pointercancel')) return;
    pointerActive = false;
    pointerId = -1;
    pointerAxis = 0;
  }

  /* ------------------------------------------------------------------ */

  function init(canvas) {
    boundCanvas = canvas;

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp, false);
    window.addEventListener('blur', onBlur, false);

    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp, false);
    window.addEventListener('pointercancel', onPointerUp, false);

    // Stop iOS/Android from scrolling or pinch-zooming the page while playing.
    canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });
    canvas.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); }, false);
  }

  /** Smooth the digital keyboard axes so steering and driving have weight. */
  function update(dt) {
    var k = 1 - Math.exp(-C.INPUT_KEY_RAMP * dt);

    var target = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
    keyAxis += (target - keyAxis) * k;
    if (Math.abs(keyAxis) < 0.001) keyAxis = 0;

    var targetY = (keyDown ? 1 : 0) - (keyUp ? 1 : 0);
    keyAxisY += (targetY - keyAxisY) * k;
    if (Math.abs(keyAxisY) < 0.001) keyAxisY = 0;
  }

  /** -1..1 steering axis. Keyboard takes priority while held. */
  function getSteer() {
    if (keyLeft || keyRight) return keyAxis;
    if (pointerActive) return pointerAxis;
    // Neither held: decay whatever the keyboard axis still has.
    return keyAxis;
  }

  function isPointerDown() { return pointerActive; }

  /* =====================================================================
   * ADVENTURE — 2D MOVEMENT VECTOR
   * ---------------------------------------------------------------------
   * The virtual stick and the keyboard are two sources for one vector. The
   * KEYBOARD WINS while any of WASD/arrows is held, for the same reason it
   * wins for steering: a stuck stick must never be able to lock the player
   * out. Nothing is held -> the residual keyboard axes decay to zero, which
   * is what gives released keys the same weight they have in classic mode.
   *
   * Diagonals are NORMALISED. Without this, holding W+D would drive 41%
   * faster than holding W, which is both wrong and immediately noticeable.
   * ================================================================== */

  /** Push the translucent thumbstick. x,y in -1..1; magnitude is clamped. */
  function setStick(x, y) {
    if (!(x === x)) x = 0;                 // NaN guard: a pointer event can
    if (!(y === y)) y = 0;                 // produce one on a torn-off touch
    var m = Math.sqrt(x * x + y * y);
    if (m > 1) { x /= m; y /= m; }
    stickX = x; stickY = y;
    stickOn = true;
  }

  function clearStick() { stickX = 0; stickY = 0; stickOn = false; }
  function isStickActive() { return stickOn; }

  /** REUSED {x, y, mag}. Read what you need inside the frame; never stash it. */
  function getMove() {
    var x, y;
    if (keyLeft || keyRight || keyUp || keyDown) { x = keyAxis; y = keyAxisY; }
    else if (stickOn) { x = stickX; y = stickY; }
    else { x = keyAxis; y = keyAxisY; }   // decaying residual

    var m = Math.sqrt(x * x + y * y);
    if (m > 1) { x /= m; y /= m; m = 1; }
    moveVec.x = x; moveVec.y = y; moveVec.mag = m;
    return moveVec;
  }

  function getMoveX() { return getMove().x; }
  function getMoveY() { return getMove().y; }
  function getMoveMag() { return getMove().mag; }

  function reset() {
    keyLeft = keyRight = false;
    keyUp = keyDown = false;
    keyAxis = 0;
    keyAxisY = 0;
    pointerActive = false;
    pointerId = -1;
    pointerAxis = 0;
    clearStick();
  }

  return {
    init: init,
    update: update,
    getSteer: getSteer,
    isPointerDown: isPointerDown,
    consumeFirstGesture: consumeFirstGesture,
    noteGesture: noteGesture,
    reset: reset,

    /* --- adventure mode --------------------------------------------- */
    setStick: setStick,
    clearStick: clearStick,
    isStickActive: isStickActive,
    getMove: getMove,
    getMoveX: getMoveX,
    getMoveY: getMoveY,
    getMoveMag: getMoveMag
  };
})();
