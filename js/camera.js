/* =============================================================================
 * SUPERMINE — js/camera.js                   [OWNER: Agent 3 — presentation]
 * -----------------------------------------------------------------------------
 * Smooth follow camera with dynamic look-ahead, DERIVED zoom, zoom punches and
 * trauma-based shake (translation + a whisper of roll).
 *
 * >>> THE CAMERA OWNS ZOOM. <<<
 * Zoom is derived here every step from:
 *     base            CAM_ZOOM
 *   x width pull-back the wider SM.vehicle.getWidth() gets, the further out
 *   x zone factor     'final' pulls back hard, 'narrow' tightens slightly
 *   x overdrive       small extra pull-back while overdrive is running
 *   x punch           snappy transient on upgrade / transform (applied AFTER
 *                     the smoothing so it actually reads as a punch)
 * `setZoomTarget()` is kept for API compatibility but is IGNORED while
 * auto-zoom is on (the default). Call setAutoZoom(false) to hand control back.
 * This makes the camera immune to whether upgrades.js still drives zoom.
 *
 * NO SLOW MOTION: main.js is frozen and has no timescale hook. Big moments are
 * sold with punch + shake + effects.screenFlash instead.
 *
 * MAX_WALL_VISIBLE FLOOR
 * The lane is a fixed 1280 units wide, so zooming out past a point reveals
 * bedrock, not more game. recomputeScale() clamps scale so we never show more
 * than MAX_WALL_VISIBLE of wall on each side. Do not remove it.
 *
 * Public API (main.js depends on these signatures — do not change them):
 *   SM.camera.init()
 *   SM.camera.update(dt)
 *   SM.camera.applyTransform(ctx)
 *   SM.camera.shake(strength)        ~3 = rumble, ~35 = big hit
 *   SM.camera.setZoomTarget(z)
 *   SM.camera.getZoom() / getScale() / getX() / getY()
 *   SM.camera.getViewBounds()        REUSED object
 *   SM.camera.worldToScreen(x,y) / screenToWorld(x,y)   REUSED object
 *   SM.camera.setViewport(w,h)
 *   SM.camera.reset()
 * Additions: punch(a), setZone(kind), setAutoZoom(b), getTrauma()
 * ========================================================================== */

var SM = SM || {};

SM.camera = (function () {
  'use strict';

  /* =====================================================================
   * Agent-3 tunables
   * ================================================================== */

  // How much bedrock wall we are willing to show on EACH side of the lane
  // before we refuse to zoom out any further. Without this floor, a zoomed-out
  // camera on a wide monitor turns the screen into two black bars with a strip
  // of game between them.
  var MAX_WALL_VISIBLE = 300;

  // Width -> zoom-out. zoomFactor = (baseWidth / currentWidth) ^ WIDTH_EXP.
  // Deliberately gentle: the lane is fixed, so aggressive pull-back just shows
  // more wall. 0.26 takes a 140->520 wide rig from 0.95 down to ~0.68.
  var WIDTH_EXP        = 0.26;
  var WIDTH_MIN_FACTOR = 0.66;   // hard floor on the width contribution

  // Per-zone multipliers (smaller = further out).
  var ZONE_FINAL       = 0.86;
  var ZONE_NARROW      = 1.05;
  var ZONE_BARRIER     = 0.97;
  var ZONE_RICH        = 0.99;
  var ZONE_LERP        = 1.6;    // how fast we ease between zone factors

  var OVERDRIVE_ZOOM   = 0.955;  // pull back a touch while overdriving

  // Zoom punch: instantaneous, decays fast, applied on top of the smoothed base.
  var PUNCH_DECAY      = 7.5;
  var PUNCH_UPGRADE    = 0.16;   // zoom IN 16% then settle
  var PUNCH_TRANSFORM  = 0.055;
  var PUNCH_PULSE      = -0.09;  // negative = kick OUT (explosion)
  var PUNCH_MAX        = 0.28;

  // Look-ahead is expressed as a FRACTION OF THE VISIBLE HALF-HEIGHT, not as a
  // fixed world distance. That keeps the machine at the same place on screen
  // whatever the zoom or the window size — a fixed distance parks it almost
  // off the bottom edge as soon as the camera pulls back. 0.37 reproduces the
  // Phase-1 framing (CAM_LOOKAHEAD 175 at zoom 0.95 on a 900px viewport),
  // i.e. the rig sits around 68% down the screen.
  var LOOKAHEAD_FRAC       = 0.37;
  var LOOKAHEAD_SPEED_GAIN = 0.30;   // extra lead per unit of speed ABOVE base
  var LOOKAHEAD_CHOICE     = 55;     // extra during 'rich' / 'barrier' zones
  var LOOKAHEAD_EXTRA_MAX  = 130;    // hard cap on everything above the base
  var LOOKAHEAD_LERP       = 2.2;

  // Steering lead: nudge the camera the way the player is pushing.
  var STEER_LEAD           = 0.16;   // fraction of lateral speed adopted

  // Shake. Trauma is squared for the amplitude, so small values stay subtle.
  //
  // TWO KINDS OF SHAKE, and the distinction is the whole reason this does not
  // saturate. `shake()` is ADDITIVE and belongs to rare, discrete moments.
  // `shakeFloor()` only RAISES trauma to a level and is used for anything that
  // can repeat every single step — impact:heavy fires up to 60x/second while
  // ploughing dense rock, and accumulating that pins the camera at max trauma
  // forever. A floor gives a steady rumble that discrete hits still punch
  // through, and it can never run away.
  //
  // Note that vehicle.js / upgrades.js / level.js also call shake() directly
  // for pulses, overdrive, gates and zones. The values below are deliberately
  // modest so the SUM stays inside a sensible range.
  var SHAKE_ROLL_MAX       = 0.011;  // radians at full trauma (~0.63 deg)
  var SHAKE_TRAUMA_CAP     = 1.25;
  var SHAKE_EVENT_HEAVY    = 16;     // FLOOR at impact:heavy strength 1
  var SHAKE_EVENT_HEAVY_MIN = 2.2;
  var SHAKE_EVENT_UPGRADE  = 10;
  var SHAKE_EVENT_TRANSFORM = 4;
  var SHAKE_EVENT_PULSE    = 10;
  var SHAKE_EVENT_GATE     = 3;
  var SHAKE_EVENT_ZONE     = 5;
  var SHAKE_EVENT_COMPLETE = 16;
  var SHAKE_GRIND_GAIN     = 5.0;    // continuous rumble from cutter resistance

  /* ================================================================== */

  var C = SM.config;

  var x = 0, y = 0;                 // camera centre in world space
  var zoomBase = C.CAM_ZOOM;        // smoothed, punch-free
  var zoom = C.CAM_ZOOM;            // what everything else sees
  var externalZoom = C.CAM_ZOOM;    // whatever setZoomTarget() last asked for
  var autoZoom = true;

  var punch = 0;

  var zoneFactor = 1, zoneFactorTarget = 1;
  var zoneLookahead = 0, zoneLookaheadTarget = 0;
  var overdriveMix = 0, overdriveTarget = 0;

  var lookahead = C.CAM_LOOKAHEAD;

  var trauma = 0;                   // 0..SHAKE_TRAUMA_CAP, decays exponentially
  var shakeX = 0, shakeY = 0, shakeRot = 0;
  var shakeTime = 0;

  var vpW = 1, vpH = 1;             // CSS pixels
  var scale = 1;                    // combined zoom * resolution factor

  var boundsOut = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  var pointOut = { x: 0, y: 0 };

  var subscribed = false;
  // Latched on the first update() that sees a plausible vehicle width, because
  // camera.init() runs BEFORE vehicle.init() and would otherwise measure a
  // half-built rig. The starting rig is identical every run, so latching once
  // keeps the width pull-back consistent across restarts.
  var baseWidth = 0;

  function ensureBaseWidth() {
    if (baseWidth > 0) return;
    var w = (SM.vehicle && SM.vehicle.getWidth) ? SM.vehicle.getWidth() : 0;
    baseWidth = (w > C.VEHICLE_BLADE_WIDTH * 0.6) ? w : C.VEHICLE_BLADE_WIDTH;
  }

  /* =====================================================================
   * SETUP
   * ================================================================== */
  function init() {
    if (!subscribed) {
      subscribed = true;
      // ALL shake lives here. effects.js deliberately does not call shake().
      // FLOOR, not accumulation: this event repeats every step while mining.
      SM.events.on('impact:heavy', function (p) {
        shakeFloor(SHAKE_EVENT_HEAVY_MIN + (p && p.strength ? p.strength : 0) * SHAKE_EVENT_HEAVY);
      });
      SM.events.on('upgrade:applied', function () {
        shake(SHAKE_EVENT_UPGRADE);
        doPunch(PUNCH_UPGRADE);
      });
      SM.events.on('vehicle:transform', function () {
        shake(SHAKE_EVENT_TRANSFORM);
        doPunch(PUNCH_TRANSFORM);
      });
      SM.events.on('pulse:fired', function () {
        shake(SHAKE_EVENT_PULSE);
        doPunch(PUNCH_PULSE);
      });
      SM.events.on('gate:passed', function () { shake(SHAKE_EVENT_GATE); });
      SM.events.on('zone:entered', function (p) {
        setZone(p && p.kind);
        shake(SHAKE_EVENT_ZONE * (zoneFactorTarget < 1 ? 1.6 : 1));
      });
      SM.events.on('overdrive:start', function () { overdriveTarget = 1; doPunch(-0.06); });
      SM.events.on('overdrive:end', function () { overdriveTarget = 0; });
      SM.events.on('level:complete', function () {
        shake(SHAKE_EVENT_COMPLETE);
        zoneFactorTarget = ZONE_FINAL * 0.94;
      });
      // NOTE: deliberately NOT subscribed to 'run:reset'. main.js already calls
      // camera.reset() early in restart(), and re-resetting after level.reset()
      // would clobber any zone the new run has already announced.
    }
    reset();
  }

  function setViewport(w, h) {
    vpW = w > 1 ? w : 1;
    vpH = h > 1 ? h : 1;
    recomputeScale();
  }

  function recomputeScale() {
    scale = zoom * (vpH / C.CAM_REFERENCE_HEIGHT);
    // Lane-fill floor: never show more world width than lane + 2*MAX_WALL_VISIBLE.
    var minScale = vpW / (C.LANE_HALF_WIDTH * 2 + MAX_WALL_VISIBLE * 2);
    if (scale < minScale) scale = minScale;
    if (scale < 0.05) scale = 0.05;
  }

  /* =====================================================================
   * ZOOM
   * ================================================================== */

  /** Kept for API compatibility. Ignored while auto-zoom is on (default). */
  function setZoomTarget(z) {
    if (z < C.CAM_ZOOM_MIN) z = C.CAM_ZOOM_MIN;
    if (z > C.CAM_ZOOM_MAX) z = C.CAM_ZOOM_MAX;
    externalZoom = z;
  }

  function setAutoZoom(b) { autoZoom = !!b; }

  /** Snappy transient. Positive punches IN, negative kicks OUT. */
  function doPunch(a) {
    punch += a;
    if (punch > PUNCH_MAX) punch = PUNCH_MAX;
    if (punch < -PUNCH_MAX) punch = -PUNCH_MAX;
  }

  function setZone(kind) {
    switch (kind) {
      case 'final':   zoneFactorTarget = ZONE_FINAL;   zoneLookaheadTarget = LOOKAHEAD_CHOICE * 0.8; break;
      case 'narrow':  zoneFactorTarget = ZONE_NARROW;  zoneLookaheadTarget = 0; break;
      case 'barrier': zoneFactorTarget = ZONE_BARRIER; zoneLookaheadTarget = LOOKAHEAD_CHOICE; break;
      case 'rich':    zoneFactorTarget = ZONE_RICH;    zoneLookaheadTarget = LOOKAHEAD_CHOICE; break;
      default:        zoneFactorTarget = 1;            zoneLookaheadTarget = 0; break;
    }
  }

  /** The camera's own opinion about how far out we should be. */
  function desiredZoom() {
    if (!autoZoom) return externalZoom;

    ensureBaseWidth();
    var w = baseWidth;
    if (SM.vehicle && SM.vehicle.getWidth) {
      var gw = SM.vehicle.getWidth();
      if (gw > 1) w = gw;
    }
    // Wider machine -> smaller factor -> zoomed out.
    var wf = Math.pow(baseWidth / w, WIDTH_EXP);
    if (wf > 1) wf = 1;                       // never zoom IN for being narrow
    if (wf < WIDTH_MIN_FACTOR) wf = WIDTH_MIN_FACTOR;

    var od = 1 + (OVERDRIVE_ZOOM - 1) * overdriveMix;

    var z = C.CAM_ZOOM * wf * zoneFactor * od;
    if (z < C.CAM_ZOOM_MIN) z = C.CAM_ZOOM_MIN;
    if (z > C.CAM_ZOOM_MAX) z = C.CAM_ZOOM_MAX;
    return z;
  }

  /* =====================================================================
   * SHAKE
   * ================================================================== */

  /** Additive trauma. Multiple hits in one frame stack, then saturate.
   *  For DISCRETE events only — see the note by the tunables. */
  function shake(strength) {
    if (!(strength > 0)) return;
    trauma += strength / C.CAM_SHAKE_MAX;
    if (trauma > SHAKE_TRAUMA_CAP) trauma = SHAKE_TRAUMA_CAP;
  }

  /** Raise trauma TO a level without accumulating. For repeating sources. */
  function shakeFloor(strength) {
    if (!(strength > 0)) return;
    var t = strength / C.CAM_SHAKE_MAX;
    if (t > SHAKE_TRAUMA_CAP) t = SHAKE_TRAUMA_CAP;
    if (trauma < t) trauma = t;
  }

  /* =====================================================================
   * UPDATE
   * ================================================================== */
  function update(dt) {
    /* --- eased state -------------------------------------------------- */
    var kz2 = 1 - Math.exp(-ZONE_LERP * dt);
    zoneFactor += (zoneFactorTarget - zoneFactor) * kz2;
    zoneLookahead += (zoneLookaheadTarget - zoneLookahead) * kz2;
    overdriveMix += (overdriveTarget - overdriveMix) * Math.min(1, dt * 3.5);

    /* --- follow target ------------------------------------------------ */
    var tx = 0, ty = 0;
    var speed = 0;
    if (SM.vehicle && SM.vehicle.getY) {
      speed = SM.vehicle.getSpeed ? SM.vehicle.getSpeed() : C.VEHICLE_SPEED;
      var lat = SM.vehicle.getLateralSpeed ? SM.vehicle.getLateralSpeed() : 0;
      tx = SM.vehicle.getX() * C.CAM_LATERAL_LEAD + lat * STEER_LEAD;

      // Base lead tracks the visible half-height, so the rig keeps its screen
      // position through every zoom change. On top of that, lead a little
      // further when going fast and while a route choice is coming up.
      var halfWorldH = (vpH * 0.5) / scale;
      var extra = Math.max(0, speed - C.VEHICLE_SPEED) * LOOKAHEAD_SPEED_GAIN
                + zoneLookahead;
      if (extra > LOOKAHEAD_EXTRA_MAX) extra = LOOKAHEAD_EXTRA_MAX;
      var laTarget = halfWorldH * LOOKAHEAD_FRAC + extra;
      lookahead += (laTarget - lookahead) * (1 - Math.exp(-LOOKAHEAD_LERP * dt));
      ty = SM.vehicle.getY() - lookahead;
    }
    // Exponential smoothing — frame-rate independent.
    var k = 1 - Math.exp(-C.CAM_FOLLOW * dt);
    x += (tx - x) * k;
    y += (ty - y) * k;

    /* --- zoom --------------------------------------------------------- */
    var target = desiredZoom();
    var kz = 1 - Math.exp(-C.CAM_ZOOM_LERP * dt);
    zoomBase += (target - zoomBase) * kz;

    // Punch is applied AFTER the smoothing, so it lands on the same frame the
    // event fired instead of being eaten by the zoom lerp.
    punch -= punch * Math.min(1, PUNCH_DECAY * dt);
    if (punch < 0.0004 && punch > -0.0004) punch = 0;
    zoom = zoomBase * (1 + punch);
    if (zoom < C.CAM_ZOOM_MIN * 0.9) zoom = C.CAM_ZOOM_MIN * 0.9;
    if (zoom > C.CAM_ZOOM_MAX * 1.1) zoom = C.CAM_ZOOM_MAX * 1.1;
    recomputeScale();

    /* --- shake -------------------------------------------------------- */
    // Continuous low rumble while the cutter is loaded. This is a TARGET floor,
    // not an accumulation, so it can never saturate the trauma budget.
    if (SM.vehicle && SM.vehicle.getResistance) {
      shakeFloor(Math.min(1, SM.vehicle.getResistance() * 0.0045) * SHAKE_GRIND_GAIN);
    }

    shakeTime += dt;
    if (trauma > 0.0001) {
      trauma -= trauma * C.CAM_SHAKE_DECAY * dt;
      if (trauma < 0.0001) trauma = 0;
      // Squared trauma feels punchier than linear.
      var t2 = trauma * trauma;
      var amp = t2 * C.CAM_SHAKE_MAX;
      // Cheap pseudo-noise: two out-of-phase sines per axis + a random kick.
      shakeX = amp * (Math.sin(shakeTime * 61.7) * 0.42 +
                      Math.sin(shakeTime * 23.1 + 2.3) * 0.22 +
                      (Math.random() * 2 - 1) * 0.36);
      shakeY = amp * (Math.sin(shakeTime * 47.3 + 1.7) * 0.42 +
                      Math.sin(shakeTime * 17.9 + 0.6) * 0.22 +
                      (Math.random() * 2 - 1) * 0.36);
      // A whisper of roll. Kept tiny: any more and the bedrock walls tilt
      // visibly and the whole frame reads as broken rather than impactful.
      shakeRot = t2 * SHAKE_ROLL_MAX * Math.sin(shakeTime * 31.4 + 0.9);
    } else {
      shakeX = 0; shakeY = 0; shakeRot = 0;
    }
  }

  /**
   * Multiply the world transform onto ctx.
   * main.js has already applied the devicePixelRatio base transform, so we
   * work in CSS pixels here.
   */
  function applyTransform(ctx) {
    ctx.translate(vpW * 0.5, vpH * 0.5);
    if (shakeRot !== 0) ctx.rotate(shakeRot);
    ctx.scale(scale, scale);
    ctx.translate(-x + shakeX / scale, -y + shakeY / scale);
  }

  /** Visible world rectangle. Reused object — never cache the reference. */
  function getViewBounds() {
    var hw = (vpW * 0.5) / scale;
    var hh = (vpH * 0.5) / scale;
    // Slack for shake translation and for the corner sweep caused by roll, so
    // culling/streaming never pops content in at the edge of a big hit.
    var slack = (Math.abs(shakeX) + Math.abs(shakeY)) / scale +
                Math.abs(shakeRot) * (hw + hh);
    boundsOut.minX = x - hw - slack;
    boundsOut.maxX = x + hw + slack;
    boundsOut.minY = y - hh - slack;
    boundsOut.maxY = y + hh + slack;
    return boundsOut;
  }

  function worldToScreen(wx, wy) {
    pointOut.x = (wx - x) * scale + vpW * 0.5 + shakeX;
    pointOut.y = (wy - y) * scale + vpH * 0.5 + shakeY;
    return pointOut;
  }

  function screenToWorld(sx, sy) {
    pointOut.x = (sx - vpW * 0.5 - shakeX) / scale + x;
    pointOut.y = (sy - vpH * 0.5 - shakeY) / scale + y;
    return pointOut;
  }

  function reset() {
    x = 0;
    y = C.START_Y - C.CAM_LOOKAHEAD;
    lookahead = C.CAM_LOOKAHEAD;
    zoom = C.CAM_ZOOM;
    zoomBase = C.CAM_ZOOM;
    externalZoom = C.CAM_ZOOM;
    punch = 0;
    zoneFactor = zoneFactorTarget = 1;
    zoneLookahead = zoneLookaheadTarget = 0;
    overdriveMix = overdriveTarget = 0;
    trauma = 0;
    shakeX = shakeY = shakeRot = 0;
    recomputeScale();
  }

  return {
    init: init,
    update: update,
    applyTransform: applyTransform,
    shake: shake,
    setZoomTarget: setZoomTarget,
    getZoom: function () { return zoom; },
    getScale: function () { return scale; },
    getX: function () { return x; },
    getY: function () { return y; },
    getViewBounds: getViewBounds,
    worldToScreen: worldToScreen,
    screenToWorld: screenToWorld,
    setViewport: setViewport,
    reset: reset,
    // additions
    shakeFloor: shakeFloor,
    punch: doPunch,
    setZone: setZone,
    setAutoZoom: setAutoZoom,
    getTrauma: function () { return trauma; }
  };
})();
