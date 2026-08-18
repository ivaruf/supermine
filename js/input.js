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
    else if (k === 'r' || k === 'R') { noteGesture(); SM.events.emit('input:restart', null); }
    else if (k === 'm' || k === 'M') { noteGesture(); SM.events.emit('input:mutetoggle', null); }
  }

  function onKeyUp(e) {
    var k = e.key;
    if (k === 'a' || k === 'A' || k === 'ArrowLeft') keyLeft = false;
    else if (k === 'd' || k === 'D' || k === 'ArrowRight') keyRight = false;
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

  /** Smooth the digital keyboard axis so steering has weight. */
  function update(dt) {
    var target = (keyRight ? 1 : 0) - (keyLeft ? 1 : 0);
    var k = 1 - Math.exp(-C.INPUT_KEY_RAMP * dt);
    keyAxis += (target - keyAxis) * k;
    if (Math.abs(keyAxis) < 0.001) keyAxis = 0;
  }

  /** -1..1 steering axis. Keyboard takes priority while held. */
  function getSteer() {
    if (keyLeft || keyRight) return keyAxis;
    if (pointerActive) return pointerAxis;
    // Neither held: decay whatever the keyboard axis still has.
    return keyAxis;
  }

  function isPointerDown() { return pointerActive; }

  function reset() {
    keyLeft = keyRight = false;
    keyAxis = 0;
    pointerActive = false;
    pointerId = -1;
    pointerAxis = 0;
  }

  return {
    init: init,
    update: update,
    getSteer: getSteer,
    isPointerDown: isPointerDown,
    consumeFirstGesture: consumeFirstGesture,
    noteGesture: noteGesture,
    reset: reset
  };
})();
