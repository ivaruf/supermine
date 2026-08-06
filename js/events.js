/* =============================================================================
 * SUPERMINE — js/events.js
 * -----------------------------------------------------------------------------
 * Tiny synchronous publish/subscribe bus. Everything cross-module that isn't a
 * documented getter goes through here.
 *
 * >>> THIS FILE IS FROZEN after Phase 1. <<<
 * Agents 2 and 3 may freely EMIT new event names and SUBSCRIBE to anything,
 * but must not change this implementation.
 *
 * Design notes
 *  - Synchronous: handlers run inside emit(). Keep them short; they can be
 *    called hundreds of times per frame (e.g. material:destroyed).
 *  - Zero allocation on the hot path: emit() walks a plain array and does not
 *    copy it unless a handler mutates the list during dispatch (guarded by a
 *    simple "dirty" re-check via index bookkeeping).
 *  - Payloads are REUSED OBJECTS in several hot emitters (see ARCHITECTURE.md).
 *    Handlers MUST read what they need immediately and MUST NOT stash the
 *    payload object for later.
 * ========================================================================== */

var SM = SM || {};

SM.events = (function () {
  'use strict';

  // name -> array of handler functions
  var map = Object.create(null);

  /** Subscribe. Returns an unsubscribe function for convenience. */
  function on(name, fn) {
    if (typeof fn !== 'function') return function () {};
    var list = map[name];
    if (!list) { list = map[name] = []; }
    list.push(fn);
    return function () { off(name, fn); };
  }

  /** Unsubscribe a previously registered handler. */
  function off(name, fn) {
    var list = map[name];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === fn) { list.splice(i, 1); return; }
    }
  }

  /** Subscribe once. */
  function once(name, fn) {
    var un = on(name, function (payload) {
      un();
      fn(payload);
    });
    return un;
  }

  /**
   * Fire an event synchronously.
   * A handler that throws is logged but never breaks the frame — a broken
   * effect or sound must not take the simulation down.
   */
  function emit(name, payload) {
    var list = map[name];
    if (!list) return;
    // Snapshot length: handlers added during dispatch are not called this time.
    for (var i = 0, n = list.length; i < n; i++) {
      var fn = list[i];
      if (!fn) continue;
      try {
        fn(payload);
      } catch (err) {
        if (window.console) console.error('[SM.events] handler error for "' + name + '"', err);
      }
      // A handler may have removed itself (or others); re-sync bounds.
      if (list.length < n) { n = list.length; i--; }
    }
  }

  /** Remove every handler for a name, or every handler entirely. */
  function clear(name) {
    if (name === undefined) {
      for (var k in map) delete map[k];
    } else {
      delete map[name];
    }
  }

  /** Debug helper: how many listeners are attached. */
  function count(name) {
    var list = map[name];
    return list ? list.length : 0;
  }

  return { on: on, off: off, once: once, emit: emit, clear: clear, count: count };
})();
