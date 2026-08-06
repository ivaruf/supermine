/* =============================================================================
 * SUPERMINE — js/main.js
 * -----------------------------------------------------------------------------
 * Bootstrap, canvas management and the fixed-timestep game loop.
 *
 * >>> THIS FILE IS FROZEN after Phase 1. <<<
 * If you need something to happen every frame, hook it into a module that is
 * already in the call order below, or subscribe to an event.
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
  var lastTime = 0;
  var accumulator = 0;

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
  function step(dt) {
    SM.input.update(dt);
    SM.level.update(dt);
    SM.terrain.update(dt);
    SM.vehicle.update(dt);
    SM.particles.update(dt);
    SM.upgrades.update(dt);
    SM.camera.update(dt);
    SM.effects.update(dt);
    SM.sound.update(dt);
    SM.ui.update(dt);
  }

  /* =====================================================================
   * RENDER
   * ================================================================== */
  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b0a0d';
    ctx.fillRect(0, 0, cssW, cssH);

    ctx.save();
    SM.camera.applyTransform(ctx);

    SM.terrain.render(ctx);
    SM.particles.render(ctx);
    SM.upgrades.render(ctx);
    SM.vehicle.render(ctx);
    SM.effects.render(ctx);

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
    // The world renders behind the start overlay, but time does not pass —
    // otherwise the run drives off without the player.
    if (!started) accumulator = 0;

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
  function restart() {
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
