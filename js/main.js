/* =============================================================================
 * SUPERMINE — js/main.js
 * -----------------------------------------------------------------------------
 * Bootstrap, canvas management and the fixed-timestep game loop.
 *
 * >>> THIS FILE IS FROZEN after Phase 1. <<<
 * If you need something to happen every frame, hook it into a module that is
 * already in the call order below, or subscribe to an event.
 *
 * ONE DELIBERATE EXCEPTION: setPaused()/isPaused() and the `game:paused` event.
 * A pause cannot be built from outside, because the thing that has to stop is
 * the fixed-step accumulator that lives in this closure and nowhere else. It
 * reuses the start-overlay gate below verbatim — no timescale, no second code
 * path, no change to the update or render order.
 *
 * UPDATE ORDER (one fixed step)
 *   input -> level -> terrain -> vehicle -> particles -> upgrades
 *         -> camera -> effects -> sound -> ui
 *
 * RENDER ORDER
 *   [world transform]  terrain background -> particles -> upgrade gates
 *                      -> vehicle -> effects
 *   [screen space]     vignette          (DOM UI floats above the canvas)
 *
 * Why this order matters
 *   - terrain streams new material in before the vehicle cuts, so the cutter
 *     never runs off the end of the generated world;
 *   - the vehicle cuts BEFORE particles integrate, so debris spawned this step
 *     moves on the same step it was created (no one-frame stall on impact);
 *   - camera updates after the vehicle so it follows the final position;
 *   - effects and sound run last: they only ever react to what already happened.
 * ========================================================================== */

var SM = SM || {};

SM.main = (function () {
  'use strict';

  var C = SM.config;

  var canvas = null;
  var ctx = null;
  var dpr = 1;
  var cssW = 1, cssH = 1;

  var running = false;
  var started = false;   // simulation is held until the player's first gesture
  var paused = false;    // ...and again whenever the pause menu is up
  var lastTime = 0;
  var accumulator = 0;

  var evPaused = { paused: false };   // reused payload, like every hot emitter

  var fps = 0;
  var fpsFrames = 0;
  var fpsTimer = 0;
  var stepMs = 0;

  var vignette = null;

  /* =====================================================================
   * CANVAS
   * ================================================================== */
  function resize() {
    // Cap DPR at 2: beyond that the fill-rate cost is not worth the pixels.
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = Math.max(1, window.innerWidth);
    cssH = Math.max(1, window.innerHeight);

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    SM.camera.setViewport(cssW, cssH);
    buildVignette();
  }

  function buildVignette() {
    var g = ctx.createRadialGradient(
      cssW * 0.5, cssH * 0.5, Math.min(cssW, cssH) * 0.35,
      cssW * 0.5, cssH * 0.5, Math.max(cssW, cssH) * 0.78
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.40)');
    vignette = g;
  }

  /* =====================================================================
   * SIMULATION STEP
   * ================================================================== */
  /**
   * True when ADVENTURE MODE owns the session. Feature-detected at every call
   * site so a build without the adventure modules still runs classic exactly
   * as before — `SM.adv` simply is not there and every branch takes the
   * classic path.
   */
  function advActive() {
    return !!(SM.adv && SM.adv.isActive && SM.adv.isActive());
  }

  function step(dt) {
    var adv = advActive();

    SM.input.update(dt);

    // The RUN DIRECTOR. level.js is the time-attack director and adv.js is the
    // expedition director; exactly one of them runs. They are mutually
    // exclusive by design — level.js owns a countdown that must not tick while
    // the player is choosing a mine, and adv.js owns fuel/cargo/heat that mean
    // nothing in a 60-second score attack.
    if (adv) SM.adv.update(dt); else SM.level.update(dt);

    SM.terrain.update(dt);
    SM.vehicle.update(dt);
    SM.particles.update(dt);

    // Upgrade GATES are a classic-mode device: adventure buys upgrades in the
    // workshop instead. Skipping this also keeps upgrades.js's progression
    // zoom-out from fighting the adventure camera every single step.
    if (!adv) SM.upgrades.update(dt);

    SM.camera.update(dt);
    SM.effects.update(dt);
    SM.sound.update(dt);
    SM.ui.update(dt);
    if (adv && SM.advhud) SM.advhud.update(dt);
  }

  /* =====================================================================
   * RENDER
   * ================================================================== */
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0a0d';
    ctx.fillRect(0, 0, cssW, cssH);

    var adv = advActive();

    ctx.save();
    SM.camera.applyTransform(ctx);

    SM.terrain.render(ctx);
    SM.particles.render(ctx);
    if (!adv) SM.upgrades.render(ctx);
    SM.vehicle.render(ctx);
    SM.effects.render(ctx);
    // LAST inside the world transform, because the adventure layer is where
    // the darkness/headlight composite lives: it has to fall on the terrain,
    // the machine AND the effects, so it cannot draw before any of them.
    if (adv) SM.adv.renderWorld(ctx);

    ctx.restore();

    // screen-space overlay
    if (vignette) {
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, cssW, cssH);
    }
  }

  /* =====================================================================
   * LOOP
   * ================================================================== */
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);

    var dt = (now - lastTime) / 1000;
    lastTime = now;
    if (!(dt > 0)) dt = 0;
    if (dt > C.MAX_FRAME_DT) dt = C.MAX_FRAME_DT;

    accumulator += dt;
    // The world renders behind the start overlay — and behind the pause menu —
    // but time does not pass, otherwise the run drives off without the player.
    // ZEROING the accumulator rather than skipping the while-loop is the whole
    // trick: a paused minute banks nothing, so the first frame after a resume
    // steps exactly once like any other frame instead of paying out sixty
    // seconds of backlog and teleporting the rig across the map.
    // The third holder is ADVENTURE MODE's meta screens (slot picker, world
    // map, workshop, prep, extraction summary). It gets its own gate rather
    // than reusing setPaused() because setPaused() emits `game:paused`, which
    // ui.js answers by opening the CLASSIC pause card — a card with a RESUME
    // button for a run that has not started. Same zeroing, no side effects.
    if (!started || paused ||
        (SM.adv && SM.adv.holdsSim && SM.adv.holdsSim())) accumulator = 0;

    var t0 = performance.now();
    var steps = 0;
    var fixed = C.FIXED_DT;
    while (accumulator >= fixed && steps < C.MAX_STEPS_PER_FRAME) {
      step(fixed);
      accumulator -= fixed;
      steps++;
    }
    // If we hit the cap we are behind: throw the backlog away rather than
    // trying to catch up (which would only make the next frame slower).
    if (steps >= C.MAX_STEPS_PER_FRAME) accumulator = 0;
    stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;

    render();

    fpsFrames++;
    fpsTimer += dt;
    if (fpsTimer >= 0.5) {
      fps = Math.round(fpsFrames / fpsTimer);
      fpsFrames = 0;
      fpsTimer = 0;
    }
  }

  /* =====================================================================
   * RUN CONTROL
   * ================================================================== */
  /**
   * Gate the simulation. RENDERING CARRIES ON regardless, so the mine is still
   * there under the menu — held on the exact frame you paused it, rather than
   * blanked out or left to a stale backbuffer.
   *
   * Pausing is REFUSED in the two states that have nothing to pause: behind
   * the start overlay (no time is passing there anyway) and after `run:over`
   * (the summary card owns the screen, and a pause menu on top of it would
   * leave the player looking at a RESUME button for a run that is already
   * scored). Un-pausing is never refused, so nothing can strand the game.
   *
   * Fires `game:paused` ON CHANGE ONLY — a button that re-asserts the state it
   * is already in must not make the menu flicker. Returns the RESULTING state,
   * so a caller can tell an accepted pause from a refused one on the spot
   * instead of asking again.
   */
  function setPaused(p) {
    p = !!p;
    if (p && !started) return paused;
    if (p && SM.level && SM.level.isRunOver && SM.level.isRunOver()) return paused;
    if (p === paused) return paused;
    paused = p;
    evPaused.paused = paused;
    SM.events.emit('game:paused', evPaused);
    return paused;
  }

  function restart() {
    // ADVENTURE owns its own restart: re-descending means rebuilding the mine
    // from its saved seed and carve mask with the loadout the player paid for,
    // none of which this function knows about. Rebuilding the CLASSIC world
    // underneath a live expedition would strand the player in a time-attack
    // lane, so hand over and get out of the way.
    if (advActive() && SM.adv.restart) { SM.adv.restart(); return; }

    // Clear the pause FIRST. RESTART is reachable from inside the pause menu,
    // so `game:paused` has to land before `run:reset`: the menu is then gone
    // by the time the fresh run announces itself, and a restarted run can
    // never come up already frozen.
    setPaused(false);

    // Order matters:
    //   vehicle+camera first  -> position and DEFAULT ZOOM are restored before
    //                            terrain sizes its streaming window from the
    //                            camera view (otherwise a zoomed-out run would
    //                            re-generate a far bigger field on restart);
    //   particles next        -> empty pool;
    //   upgrades then level   -> gates cleared, then re-placed;
    //   terrain last          -> repopulates, carving the new gate openings.
    SM.vehicle.reset();
    SM.camera.reset();
    SM.particles.reset();
    SM.upgrades.reset();
    SM.level.reset();
    SM.terrain.reset();
    SM.effects.reset();
    SM.sound.reset();
    SM.input.reset();
    accumulator = 0;
    SM.events.emit('run:reset', null);
  }

  function init() {
    canvas = document.getElementById('game');
    if (!canvas) throw new Error('SUPERMINE: #game canvas not found');
    ctx = canvas.getContext('2d', { alpha: false });

    SM.input.init(canvas);
    SM.particles.init();
    SM.camera.init();
    // ADVENTURE DATA LAYER, before anything can ask it a question. Pure data
    // and localStorage: no canvas, no camera, no particles. Ordered
    // mines -> rig -> save because save.js validates a loaded slot against
    // the catalogues (an unknown mine id or part key must not boot a company
    // into an inconsistent state).
    if (SM.mines) SM.mines.init();
    if (SM.rig) SM.rig.init();
    if (SM.save) SM.save.init();
    // Viewport BEFORE terrain: terrain sizes its streaming window from the
    // camera's visible bounds, which are meaningless until the canvas is sized.
    resize();
    SM.vehicle.init();
    SM.upgrades.init();
    SM.level.init();          // must run before terrain (gate openings)
    SM.terrain.init();
    SM.effects.init();
    SM.sound.init();
    SM.ui.init();

    // ADVENTURE, after everything it drives exists. adv.js LAST of the four:
    // it is the state machine, and opening a state must be able to reach a
    // fully-built terrain streamer, scanner, HUD, joystick and screen stack.
    if (SM.advterrain) SM.advterrain.init();
    if (SM.scanner) SM.scanner.init();
    if (SM.joystick) SM.joystick.init();
    if (SM.advhud) SM.advhud.init();
    if (SM.advui) SM.advui.init();
    if (SM.adv) SM.adv.init();

    window.addEventListener('resize', resize, false);
    window.addEventListener('orientationchange', resize, false);
    SM.events.on('input:restart', restart);
    SM.events.on('input:firstgesture', function () { started = true; });

    running = true;
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }

  return {
    init: init,
    restart: restart,
    setPaused: setPaused,
    isPaused: function () { return paused; },
    getFps: function () { return fps; },
    getStepMs: function () { return stepMs; },
    getCanvas: function () { return canvas; },
    getContext: function () { return ctx; },
    getViewportWidth: function () { return cssW; },
    getViewportHeight: function () { return cssH; },
    isRunning: function () { return running; }
  };
})();

/* --- boot ------------------------------------------------------------- */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { SM.main.init(); });
} else {
  SM.main.init();
}
