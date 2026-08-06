/* =============================================================================
 * SUPERMINE — js/effects.js                    [OWNER: Agent 3 — presentation]
 * -----------------------------------------------------------------------------
 * The spectacle layer. A pooled, capped, allocation-free visual particle system
 * that is completely separate from SM.particles: nothing in here touches the
 * simulation, so it can be budgeted away without changing gameplay.
 *
 * WHAT IT DRAWS
 *   dust puffs          material-tinted soft blobs on destruction
 *   debris chips        little tumbling material-coloured chunks
 *   sparks              directional streaks from grinding contact
 *   rings / shockwaves  expanding circles (heavy impact, pulse, upgrade)
 *   flashes             additive blobs at collection / rare breaks
 *   glints              8-point metal star, sells "chrome" moments
 *   streaks             collection trails + overdrive speed lines
 *   smoke               exhaust plume behind the machine
 *   text popups         floating "+value", rapid pickups MERGE into combos
 *   overlays            screen flash + overdrive colour grade (world-space rect)
 *
 * PERFORMANCE CONTRACT — do not weaken any of this
 *   * material:destroyed fires up to ~150x per simulation step. Every handler
 *     here is O(1), allocates nothing, and spends from FX_BUDGET_PER_STEP.
 *     Overflow is silently dropped — that is the whole point of the budget.
 *   * Event payload objects are REUSED by the engine. Fields are read
 *     immediately; nothing is ever stashed.
 *   * Rapid pickups are ACCUMULATED into a single combo popup instead of
 *     spawning one popup per pickup.
 *   * All shake lives in camera.js. effects.js never calls camera.shake().
 *
 * Public API (contract — do not change these signatures)
 *   SM.effects.init() / reset() / update(dt) / render(ctx)
 *   SM.effects.dust(x,y,matIndex,count,speed)
 *   SM.effects.sparks(x,y,matIndex,count,speed)
 *   SM.effects.ring(x,y,radius,life,r,g,b)
 *   SM.effects.flash(x,y,size,matIndex)
 *   SM.effects.getCount()
 * Additions (safe to call from anywhere)
 *   SM.effects.chips / smoke / glint / streak / shock / popup / burst
 *   SM.effects.screenFlash(strength,r,g,b)
 *   SM.effects.getIntensity()
 * ========================================================================== */

var SM = SM || {};

SM.effects = (function () {
  'use strict';

  /* =====================================================================
   * Agent-3 tunables
   * ================================================================== */
  var DUST_DRAG        = 3.4;
  var SPARK_DRAG       = 5.6;
  var CHIP_DRAG        = 2.3;
  var SMOKE_DRAG       = 1.15;
  var STREAK_DRAG      = 4.0;

  var RING_LIFE        = 0.42;

  var PUFF_TEX         = 48;    // px, soft blob texture
  var SMOKE_TEX        = 56;
  var STAR_TEX         = 72;
  var CHIP_TEX         = 18;
  var CHIP_FRAMES      = 8;     // baked rotations (never call ctx.rotate)

  // How many destroy events in one step still get the "rich" treatment. Past
  // this we fall back to a cheap stochastic trickle so a 150-break step does
  // not simply burn the whole budget on the first 90 chips.
  var RICH_DESTROYS_PER_STEP = 20;

  // Rings and glints are the two BIG additive draws (a full arc stroke and a
  // large star sprite). The generic per-step FX budget is not enough on its
  // own: a pocket of rare deposits breaking together stacked 20 shockwaves on
  // the machine and turned the lane into white soup. These are TIME gates, not
  // per-step budgets, so the on-screen density stays constant no matter how
  // hard the events are pouring in. Showpieces pass forced=true to bypass.
  var RING_MIN_GAP     = 0.085;   // ~12 rings/s -> ~4 alive at once
  var GLINT_MIN_GAP    = 0.11;    // ~9 glints/s -> ~2 alive at once

  var COMBO_WINDOW     = 0.24;  // s of pickups merged into one popup
  var COMBO_MAX_HOLD   = 0.85;  // ...but never hold longer than this
  var POPUP_LIFE       = 1.00;
  var POPUP_RISE       = 66;    // world units/s the popup floats forward
  var POPUP_FONT       = 20;    // world units at 1x; grows with combo size
  var POPUP_FONT_MAX   = 40;
  var POPUP_CLEARANCE  = 46;    // world units clear of the rig's flank

  var COLLECT_POP_CHANCE = 0.34;
  var COLLECT_STREAK_CHANCE = 0.20;

  var EXHAUST_RATE     = 15;    // puffs/s at full speed
  var GRIND_SPARK_RATE = 52;    // sparks/s at full cutter resistance
  var OVERDRIVE_STREAK_RATE = 26;

  var FIREWORK_MIN     = 0.34;  // s between ambient final-zone fireworks
  var FIREWORK_MAX     = 0.85;

  var SCREEN_FLASH_MAX = 0.52;
  var GRADE_MAX_ALPHA  = 0.085;

  /* =====================================================================
   * Storage
   * ================================================================== */
  var C = SM.config;
  var TAU = Math.PI * 2;

  var DUST = 0, SPARK = 1, RING = 2, FLASH = 3,
      CHIP = 4, TEXT = 5, STREAK = 6, SMOKE = 7, GLINT = 8;

  var CAP = C.FX_CAPACITY;

  var fx    = new Float32Array(CAP);
  var fy    = new Float32Array(CAP);
  var fvx   = new Float32Array(CAP);
  var fvy   = new Float32Array(CAP);
  var fLife = new Float32Array(CAP);
  var fMax  = new Float32Array(CAP);
  var fSize = new Float32Array(CAP);
  var fRot  = new Float32Array(CAP);
  var fRotV = new Float32Array(CAP);
  var fA    = new Float32Array(CAP);   // per-type spare (thickness / grow / scale)
  var fR    = new Uint8Array(CAP);
  var fG    = new Uint8Array(CAP);
  var fB    = new Uint8Array(CAP);
  var fType = new Uint8Array(CAP);
  var fMat  = new Uint8Array(CAP);
  var fText = new Array(CAP);          // only ever touched for TEXT slots

  var freeStack = new Int32Array(CAP);
  var freeCount = 0;
  var actList   = new Int32Array(CAP);
  var actSlot   = new Int32Array(CAP);
  var actCount  = 0;

  var budget = 0;
  var ringCd = 0;
  var glintCd = 0;
  var destroysThisStep = 0;
  var comboSide = 1;

  /* --- baked textures ------------------------------------------------- */
  var puffs = [];        // [matIndex] -> tinted soft blob
  var chipTex = [];      // [matIndex] -> CHIP_FRAMES-wide rotation strip
  var whitePuff = null;
  var smokeTex = null;
  var starTex = null;

  /* --- flattened material lookups (no property access on the hot path) - */
  var matR = null, matG = null, matB = null;       // highlight colour
  var matBR = null, matBG = null, matBB = null;    // base colour
  var matValue = null, matSparkle = null, matGlow = null;
  var matCount = 0;

  /* --- ambient / state ------------------------------------------------ */
  var clock = 0;
  var exhaustAcc = 0;
  var grindAcc = 0;
  var streakAcc = 0;
  var fireworkTimer = 0;

  var comboValue = 0, comboCount = 0, comboX = 0, comboY = 0;
  var valueMult = 1;            // ORE REFINERY multiplier — popups show the paid value
  var comboTimer = 0, comboHold = 0;

  var overdrive = 0;          // 0..1 sustained intensity
  var overdriveTarget = 0;
  var overdriveLeft = 0;

  var flashAmt = 0;           // screen flash 0..1
  var flashR = 255, flashG = 255, flashB = 255;

  var zoneKind = 'opening';
  var zoneLevel = 0;          // 0..4, drives ambient density
  var subscribed = false;

  var fontCache = [];         // [px] -> "900 NNpx ..." string

  /* =====================================================================
   * POOL — O(1) alloc / release via swap-remove
   * ================================================================== */
  function alloc() {
    if (freeCount === 0 || budget <= 0) return -1;
    budget--;
    var i = freeStack[--freeCount];
    actSlot[i] = actCount;
    actList[actCount++] = i;
    return i;
  }

  /** Allocate ignoring the per-step budget. Reserved for once-in-a-while
   *  showpieces (upgrade flourish, pulse, level complete). */
  function allocForced() {
    if (freeCount === 0) return -1;
    var i = freeStack[--freeCount];
    actSlot[i] = actCount;
    actList[actCount++] = i;
    return i;
  }

  function release(i) {
    var s = actSlot[i];
    var last = actList[--actCount];
    actList[s] = last;
    actSlot[last] = s;
    if (fType[i] === TEXT) fText[i] = null;
    freeStack[freeCount++] = i;
  }

  /* =====================================================================
   * TEXTURE BAKING (once, in init)
   * ================================================================== */
  function makePuff(r, g, b, size, softness) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = size;
    var c = cv.getContext('2d');
    var h = size * 0.5;
    var grd = c.createRadialGradient(h, h, 0, h, h, h);
    grd.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.9 * softness) + ')');
    grd.addColorStop(0.42, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.36 * softness) + ')');
    grd.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
    c.fillStyle = grd;
    c.fillRect(0, 0, size, size);
    return cv;
  }

  /** Eight-point additive star — the "metal glint" / rare-break sparkle. */
  function makeStar() {
    var cv = document.createElement('canvas');
    cv.width = cv.height = STAR_TEX;
    var c = cv.getContext('2d');
    var h = STAR_TEX * 0.5;

    // soft core
    var core = c.createRadialGradient(h, h, 0, h, h, h * 0.36);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = core;
    c.fillRect(0, 0, STAR_TEX, STAR_TEX);

    // four spikes: two axis-aligned long, two diagonal short
    c.translate(h, h);
    for (var k = 0; k < 4; k++) {
      var len = (k % 2 === 0) ? h * 0.98 : h * 0.52;
      var wide = (k % 2 === 0) ? h * 0.075 : h * 0.045;
      c.save();
      c.rotate(k * Math.PI / 4);
      var g = c.createLinearGradient(-len, 0, len, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(-len, 0);
      c.lineTo(0, -wide);
      c.lineTo(len, 0);
      c.lineTo(0, wide);
      c.closePath();
      c.fill();
      c.restore();
    }
    return cv;
  }

  /** Rotation strip of angular chunks in one material's colours. */
  function makeChipStrip(base, shadow, hi) {
    var cv = document.createElement('canvas');
    cv.width = CHIP_TEX * CHIP_FRAMES;
    cv.height = CHIP_TEX;
    var c = cv.getContext('2d');
    var h = CHIP_TEX * 0.5;
    // One fixed silhouette rotated through the strip so a tumbling chip reads
    // as a solid object rather than a shimmering blob.
    var pts = 5;
    var rad = [];
    for (var p = 0; p < pts; p++) rad.push(h * (0.58 + Math.random() * 0.36));

    for (var f = 0; f < CHIP_FRAMES; f++) {
      c.save();
      c.translate(f * CHIP_TEX + h, h);
      c.rotate(f * TAU / CHIP_FRAMES);
      c.beginPath();
      for (var q = 0; q < pts; q++) {
        var a = q * TAU / pts;
        var rr = rad[q];
        var px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (q === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath();
      c.fillStyle = base;
      c.fill();
      // top-left lit edge
      c.strokeStyle = hi;
      c.lineWidth = 1.4;
      c.stroke();
      // bottom-right shadow wedge
      c.globalAlpha = 0.55;
      c.fillStyle = shadow;
      c.beginPath();
      c.moveTo(0, 0);
      for (var q2 = 1; q2 <= 2; q2++) {
        var a2 = (q2 % pts) * TAU / pts;
        c.lineTo(Math.cos(a2) * rad[q2 % pts], Math.sin(a2) * rad[q2 % pts]);
      }
      c.closePath();
      c.fill();
      c.restore();
    }
    return cv;
  }

  function hexToRgb(css, out) {
    var r = 200, g = 200, b = 200;
    if (typeof css === 'string' && css.charAt(0) === '#') {
      var h = css.slice(1);
      if (h.length === 3) {
        r = parseInt(h[0] + h[0], 16); g = parseInt(h[1] + h[1], 16); b = parseInt(h[2] + h[2], 16);
      } else if (h.length >= 6) {
        r = parseInt(h.substr(0, 2), 16); g = parseInt(h.substr(2, 2), 16); b = parseInt(h.substr(4, 2), 16);
      }
    }
    out[0] = r; out[1] = g; out[2] = b;
    return out;
  }

  var tmpRgb = [0, 0, 0];

  function buildTextures() {
    var list = SM.materials.list;
    matCount = list.length;
    puffs.length = 0;
    chipTex.length = 0;

    matR = new Uint8Array(matCount); matG = new Uint8Array(matCount); matB = new Uint8Array(matCount);
    matBR = new Uint8Array(matCount); matBG = new Uint8Array(matCount); matBB = new Uint8Array(matCount);
    matValue = new Float32Array(matCount);
    matSparkle = new Float32Array(matCount);
    matGlow = new Uint8Array(matCount);

    for (var i = 0; i < matCount; i++) {
      var m = list[i];
      hexToRgb(m.colors[2] || m.colors[0], tmpRgb);
      matR[i] = tmpRgb[0]; matG[i] = tmpRgb[1]; matB[i] = tmpRgb[2];
      hexToRgb(m.colors[0], tmpRgb);
      matBR[i] = tmpRgb[0]; matBG[i] = tmpRgb[1]; matBB[i] = tmpRgb[2];
      matValue[i] = m.value || 0;
      matSparkle[i] = m.sparkle || 0;
      matGlow[i] = m.glow ? 1 : 0;

      // Dust is a desaturated, lifted version of the base rock colour.
      var dr = Math.min(255, (matBR[i] * 0.55 + 90) | 0);
      var dg = Math.min(255, (matBG[i] * 0.55 + 84) | 0);
      var db = Math.min(255, (matBB[i] * 0.55 + 78) | 0);
      puffs.push(makePuff(dr, dg, db, PUFF_TEX, 1));
      chipTex.push(makeChipStrip(m.colors[0], m.colors[1] || m.colors[0], m.colors[2] || m.colors[0]));
    }

    whitePuff = makePuff(255, 250, 235, PUFF_TEX, 1);
    smokeTex = makePuff(72, 74, 82, SMOKE_TEX, 0.8);
    starTex = makeStar();
  }

  /* =====================================================================
   * SPAWNERS
   * ================================================================== */
  function dust(x, y, mat, count, speed) {
    for (var k = 0; k < count; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = Math.random() * TAU;
      var s = speed * (0.3 + Math.random() * 0.7);
      fx[i] = x; fy[i] = y;
      fvx[i] = Math.cos(a) * s;
      fvy[i] = Math.sin(a) * s;
      fMax[i] = C.FX_DUST_LIFE * (0.7 + Math.random() * 0.7);
      fLife[i] = fMax[i];
      fSize[i] = 9 + Math.random() * 15;
      fRot[i] = Math.random() * TAU;
      fRotV[i] = (Math.random() - 0.5) * 2;
      fA[i] = 24 + Math.random() * 16;     // bloom rate
      fType[i] = DUST;
      fMat[i] = mat;
    }
  }

  /** Directional sparks. dirX/dirY optional: omit for a full radial burst. */
  function sparksDir(x, y, mat, count, speed, dirX, dirY, spread) {
    var r = matR[mat] !== undefined ? matR[mat] : 255;
    var g = matG[mat] !== undefined ? matG[mat] : 220;
    var b = matB[mat] !== undefined ? matB[mat] : 160;
    var baseA = (dirX === undefined) ? 0 : Math.atan2(dirY, dirX);
    var sp = (dirX === undefined) ? Math.PI : (spread === undefined ? 0.9 : spread);
    for (var k = 0; k < count; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = baseA + (Math.random() * 2 - 1) * sp;
      var s = speed * (0.45 + Math.random() * 0.9);
      fx[i] = x; fy[i] = y;
      fvx[i] = Math.cos(a) * s;
      fvy[i] = Math.sin(a) * s;
      fMax[i] = C.FX_SPARK_LIFE * (0.55 + Math.random() * 0.9);
      fLife[i] = fMax[i];
      fSize[i] = 3 + Math.random() * 5;
      fType[i] = SPARK;
      fMat[i] = mat;
      // Sparks run hot: lift toward white at the head of their life.
      fR[i] = r < 235 ? (r + 20) : 255;
      fG[i] = g < 235 ? (g + 20) : 255;
      fB[i] = b;
    }
  }

  function sparks(x, y, mat, count, speed) {
    sparksDir(x, y, mat, count, speed, undefined, undefined, undefined);
  }

  function chips(x, y, mat, count, speed, dirX, dirY) {
    var baseA = (dirX === undefined) ? 0 : Math.atan2(dirY, dirX);
    var sp = (dirX === undefined) ? Math.PI : 1.25;
    for (var k = 0; k < count; k++) {
      var i = alloc();
      if (i < 0) return;
      var a = baseA + (Math.random() * 2 - 1) * sp;
      var s = speed * (0.4 + Math.random() * 0.95);
      fx[i] = x; fy[i] = y;
      fvx[i] = Math.cos(a) * s;
      fvy[i] = Math.sin(a) * s;
      fMax[i] = 0.42 + Math.random() * 0.42;
      fLife[i] = fMax[i];
      fSize[i] = 2.6 + Math.random() * 3.4;
      fRot[i] = Math.random() * TAU;
      fRotV[i] = (Math.random() - 0.5) * 26;
      fType[i] = CHIP;
      fMat[i] = mat;
    }
  }

  // `forced` is an additive 8th argument: the documented 7-argument signature
  // is unchanged, and showpieces pass true so their rings are never eaten by
  // the throttle that keeps ordinary destruction readable.
  function ring(x, y, radius, life, r, g, b, forced) {
    if (!forced && ringCd > 0) return;
    var i = forced ? allocForced() : alloc();
    if (i < 0) return;
    if (!forced) ringCd = RING_MIN_GAP;
    fx[i] = x; fy[i] = y;
    fvx[i] = 0; fvy[i] = 0;
    fMax[i] = life || RING_LIFE;
    fLife[i] = fMax[i];
    fSize[i] = radius;
    fA[i] = 2.4;                 // growth factor
    fType[i] = RING;
    fMat[i] = 0;                 // 0 = thin ring
    fR[i] = r === undefined ? 255 : r;
    fG[i] = g === undefined ? 240 : g;
    fB[i] = b === undefined ? 200 : b;
  }

  /** Fat shockwave: thicker stroke, faster growth, inner glow. */
  function shock(x, y, radius, life, r, g, b, forced) {
    if (!forced && ringCd > 0) return;
    var i = forced ? allocForced() : alloc();
    if (i < 0) return;
    if (!forced) ringCd = RING_MIN_GAP;
    fx[i] = x; fy[i] = y;
    fvx[i] = 0; fvy[i] = 0;
    fMax[i] = life || 0.55;
    fLife[i] = fMax[i];
    fSize[i] = radius;
    fA[i] = 3.4;
    fType[i] = RING;
    fMat[i] = 1;                 // 1 = shockwave
    fR[i] = r === undefined ? 255 : r;
    fG[i] = g === undefined ? 240 : g;
    fB[i] = b === undefined ? 200 : b;
  }

  function flash(x, y, size, mat) {
    var i = alloc();
    if (i < 0) return;
    fx[i] = x; fy[i] = y;
    fvx[i] = 0; fvy[i] = 0;
    fMax[i] = 0.18;
    fLife[i] = fMax[i];
    fSize[i] = size;
    fType[i] = FLASH;
    fMat[i] = mat === undefined ? 0 : mat;
  }

  function glint(x, y, size, life, r, g, b, forced) {
    if (!forced && glintCd > 0) return;
    var i = forced ? allocForced() : alloc();
    if (i < 0) return;
    if (!forced) glintCd = GLINT_MIN_GAP;
    fx[i] = x; fy[i] = y;
    fvx[i] = 0; fvy[i] = 0;
    fMax[i] = life || 0.30;
    fLife[i] = fMax[i];
    fSize[i] = size;
    fType[i] = GLINT;
    fR[i] = r === undefined ? 255 : r;
    fG[i] = g === undefined ? 250 : g;
    fB[i] = b === undefined ? 235 : b;
  }

  function smoke(x, y, vx, vy, size) {
    var i = alloc();
    if (i < 0) return;
    fx[i] = x; fy[i] = y;
    fvx[i] = vx; fvy[i] = vy;
    fMax[i] = 0.75 + Math.random() * 0.55;
    fLife[i] = fMax[i];
    fSize[i] = size;
    fRot[i] = Math.random() * TAU;
    fRotV[i] = (Math.random() - 0.5) * 1.2;
    fA[i] = 30 + Math.random() * 22;
    fType[i] = SMOKE;
  }

  /** Additive trail line. Length/direction come from the velocity. */
  function streak(x, y, vx, vy, len, life, r, g, b) {
    var i = alloc();
    if (i < 0) return;
    fx[i] = x; fy[i] = y;
    fvx[i] = vx; fvy[i] = vy;
    fMax[i] = life;
    fLife[i] = life;
    fSize[i] = len;
    fType[i] = STREAK;
    fR[i] = r; fG[i] = g; fB[i] = b;
  }

  function fontFor(px) {
    var k = px | 0;
    if (k < 6) k = 6;
    if (k > 90) k = 90;
    var s = fontCache[k];
    if (!s) {
      s = '900 ' + k + 'px ui-sans-serif, system-ui, "Segoe UI", Roboto, Arial, sans-serif';
      fontCache[k] = s;
    }
    return s;
  }

  function popup(x, y, text, size, r, g, b) {
    var i = allocForced();     // popups are already merged; never drop them
    if (i < 0) return;
    fx[i] = x; fy[i] = y;
    fvx[i] = (Math.random() - 0.5) * 26;
    fvy[i] = -POPUP_RISE;
    fMax[i] = POPUP_LIFE;
    fLife[i] = POPUP_LIFE;
    fSize[i] = size;
    fA[i] = 0;                 // pop-in animation phase
    fType[i] = TEXT;
    fText[i] = text;
    fR[i] = r; fG[i] = g; fB[i] = b;
  }

  /**
   * Glowing burst + shockwave — rare/crystal destruction, pulses, fireworks.
   * Sizes are deliberately restrained: several of these can land in one step
   * and additive blobs stack multiplicatively. Big is what `forced` is for.
   */
  function burst(x, y, mat, power, forced) {
    var saved = budget;
    if (forced) budget = 999;
    var r = matR[mat] !== undefined ? matR[mat] : 255;
    var g = matG[mat] !== undefined ? matG[mat] : 235;
    var b = matB[mat] !== undefined ? matB[mat] : 190;
    flash(x, y, 9 + power * 13, mat);
    glint(x, y, 16 + power * 20, 0.20 + power * 0.12, r, g, b, forced);
    if (forced) shock(x, y, 14 + power * 22, 0.36 + power * 0.2, r, g, b, true);
    else ring(x, y, 12 + power * 18, 0.30 + power * 0.14, r, g, b);
    sparks(x, y, mat, (3 + power * 9) | 0, 250 + power * 320);
    chips(x, y, mat, (2 + power * 4) | 0, 170 + power * 180);
    if (forced) budget = saved;
  }

  function screenFlash(strength, r, g, b) {
    if (strength > flashAmt) {
      flashAmt = strength > SCREEN_FLASH_MAX ? SCREEN_FLASH_MAX : strength;
      flashR = r === undefined ? 255 : r;
      flashG = g === undefined ? 250 : g;
      flashB = b === undefined ? 240 : b;
    }
  }

  /* =====================================================================
   * EVENT HOOKS — every one of these is O(1) and allocation-free
   * ================================================================== */

  /** Up to ~150x per step. The budget plus the rich/cheap split is what keeps
   *  a full-blast excavation from costing anything. */
  function onDestroyed(p) {
    var m = p.matIndex;
    if (m >= matCount) m = 0;
    var val = matValue[m];
    destroysThisStep++;

    // Precious material always gets the full treatment — it is rare enough
    // that it can never dominate the budget.
    if (val >= 150) {
      burst(p.x, p.y, m, 0.7, false);
      screenFlash(0.05, matR[m], matG[m], matB[m]);
      return;
    }
    if (val >= 25) {                       // gold / gem / crystal tier
      flash(p.x, p.y, 13, m);
      sparksDir(p.x, p.y, m, 3, 300, 0, 1, 2.2);
      chips(p.x, p.y, m, 2, 200);
      dust(p.x, p.y, m, 1, 70);
      return;
    }

    var rich = destroysThisStep <= RICH_DESTROYS_PER_STEP;
    if (rich || Math.random() < 0.22) dust(p.x, p.y, m, 1, 62);
    if (rich ? Math.random() < 0.75 : Math.random() < 0.14) chips(p.x, p.y, m, 1, 165);
    if (matSparkle[m] > 0) {
      if (Math.random() < matSparkle[m] * 0.55) sparks(p.x, p.y, m, 2, 240);
    } else if (Math.random() < (rich ? 0.22 : 0.05)) {
      sparks(p.x, p.y, m, 1, 175);
    }
  }

  /** Grinding contact. Rate limited by particles.js to <=3/step. */
  function onHit(p) {
    var m = p.matIndex;
    if (m >= matCount) m = 0;
    // Sparks fly BACK past the machine (+y) and outward from the lane centre.
    var side = p.x < 0 ? -0.55 : 0.55;
    var n = 1 + ((p.intensity * 4) | 0);
    sparksDir(p.x, p.y, m, n, 240 + p.intensity * 260, side, 1, 0.85);
    if (p.intensity > 0.6 && Math.random() < 0.4) flash(p.x, p.y, 8, m);
  }

  function onMultiplier(p) {
    valueMult = (p && typeof p.value === 'number') ? p.value : 1;
  }

  /** Up to ~30x per step. Merge into a combo popup; never one popup each. */
  function onCollected(p) {
    var m = p.matIndex;
    if (m >= matCount) m = 0;

    comboValue += p.value * valueMult;
    comboCount++;
    comboX = p.x; comboY = p.y;
    if (comboTimer <= 0) comboHold = 0;
    comboTimer = COMBO_WINDOW;

    var sp = matSparkle[m];
    // The satisfying "pop" at the exact moment of capture.
    if (sp > 0 ? (Math.random() < COLLECT_POP_CHANCE * sp) : (Math.random() < 0.05)) {
      flash(p.x, p.y, 9 + sp * 5, m);
    }
    // Sparkle trail: a short additive streak pointing back the way it flew.
    if (Math.random() < COLLECT_STREAK_CHANCE * (0.4 + sp)) {
      var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();
      var dx = p.x - vx, dy = p.y - vy;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      streak(p.x, p.y, (dx / d) * 210, (dy / d) * 210, 22 + sp * 18, 0.20,
             matR[m], matG[m], matB[m]);
    }
    if (matGlow[m] && Math.random() < 0.10) glint(p.x, p.y, 20, 0.2, matR[m], matG[m], matB[m]);
  }

  /** Fires several times a second while ploughing. Keep it cheap and small. */
  function onHeavy(p) {
    ring(p.x, p.y, 24 + p.strength * 38, 0.32, 255, 226, 170);
    dust(p.x, p.y, 1, 2, 130);
    if (p.strength > 0.7) {
      chips(p.x, p.y, 1, 3, 260);
      screenFlash(0.045 * p.strength, 255, 236, 200);
    }
  }

  /* --- showpieces ----------------------------------------------------- */

  function onUpgrade() {
    var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();
    var fy2 = SM.vehicle.getBladeFrontY ? SM.vehicle.getBladeFrontY() : vy - 90;
    var w = SM.vehicle.getWidth ? SM.vehicle.getWidth() : 140;

    var saved = budget;
    budget = 260;                       // one-off: buy the whole flourish
    // radial sparks off the blade + the chassis
    sparks(vx, fy2, 3, 34, 560);
    sparks(vx, vy, 5, 26, 420);
    // metal glint flash across the machine
    glint(vx, vy, w * 1.15, 0.42, 255, 252, 240, true);
    glint(vx, fy2, w * 0.6, 0.30, 190, 245, 255, true);
    // expanding rings
    shock(vx, vy, 34, 0.62, 150, 240, 255, true);
    shock(vx, vy, 70, 0.85, 255, 255, 255, true);
    ring(vx, vy, 110, 1.05, 120, 210, 255, true);
    dust(vx, vy, 1, 12, 210);
    chips(vx, fy2, 2, 10, 340);
    budget = saved;

    screenFlash(0.40, 190, 240, 255);
  }

  function onTransform(p) {
    var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();
    var half = (p && p.width ? p.width : 140) * 0.5;
    var saved = budget;
    budget = 70;
    // Sparks welding along both flanks as the new metal slides into place.
    sparksDir(vx - half, vy, 2, 8, 320, -1, 0.3, 0.8);
    sparksDir(vx + half, vy, 2, 8, 320, 1, 0.3, 0.8);
    glint(vx - half, vy, 40, 0.26, 255, 250, 230, true);
    glint(vx + half, vy, 40, 0.26, 255, 250, 230, true);
    budget = saved;
  }

  function onPulse(p) {
    var rad = p.radius || 260;
    var saved = budget;
    budget = 200;
    shock(p.x, p.y, rad * 0.30, 0.42, 255, 220, 150, true);
    shock(p.x, p.y, rad * 0.52, 0.62, 255, 160, 70, true);
    ring(p.x, p.y, rad * 0.75, 0.80, 255, 240, 210, true);
    flash(p.x, p.y, rad * 0.34, 3);
    glint(p.x, p.y, rad * 0.7, 0.34, 255, 230, 170, true);
    sparks(p.x, p.y, 3, 30, 700);
    chips(p.x, p.y, 1, 14, 460);
    dust(p.x, p.y, 1, 16, 300);
    budget = saved;
    screenFlash(0.34, 255, 214, 150);
  }

  function onGate(p) {
    var saved = budget;
    budget = 90;
    shock(p.x, p.y, 34, 0.55, 120, 240, 255, true);
    ring(p.x, p.y, 60, 0.7, 180, 250, 255, true);
    sparksDir(p.x, p.y, 5, 14, 300, 0, 1, 2.4);
    budget = saved;
    screenFlash(0.12, 150, 235, 255);
  }

  function onOverdriveStart(p) {
    overdriveTarget = 1;
    overdriveLeft = (p && p.duration) || 6;
    var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();
    var saved = budget;
    budget = 160;
    shock(vx, vy, 50, 0.7, 255, 150, 60, true);
    shock(vx, vy, 100, 0.95, 255, 220, 120, true);
    sparks(vx, vy, 3, 24, 520);
    glint(vx, vy, 150, 0.4, 255, 190, 90, true);
    budget = saved;
    screenFlash(0.30, 255, 170, 80);
  }

  function onOverdriveEnd() {
    overdriveTarget = 0;
    overdriveLeft = 0;
  }

  function onZone(p) {
    zoneKind = (p && p.kind) || 'opening';
    zoneLevel = zoneKind === 'final' ? 4
              : zoneKind === 'narrow' ? 3
              : zoneKind === 'barrier' ? 2
              : zoneKind === 'rich' ? 1 : 0;
    if (zoneLevel >= 1) {
      var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();
      var saved = budget;
      budget = 120;
      shock(vx, vy - 120, 60 + zoneLevel * 25, 0.9,
            zoneLevel >= 4 ? 255 : 140, zoneLevel >= 4 ? 180 : 220, zoneLevel >= 4 ? 90 : 255, true);
      if (zoneLevel >= 4) {
        sparks(vx, vy - 120, 3, 26, 520);
        screenFlash(0.34, 255, 200, 120);
      }
      budget = saved;
    }
    fireworkTimer = 0.4;
  }

  function onComplete() {
    var vx = SM.vehicle.getX(), vy = SM.vehicle.getY();
    var saved = budget;
    budget = 320;
    for (var k = 0; k < 5; k++) {
      shock(vx + (Math.random() - 0.5) * 420, vy - 60 - Math.random() * 260,
            30 + Math.random() * 60, 0.8 + Math.random() * 0.5,
            255, 200 + (Math.random() * 55) | 0, 120, true);
    }
    sparks(vx, vy - 100, 4, 44, 620);
    budget = saved;
    screenFlash(0.5, 255, 240, 200);
  }

  /* =====================================================================
   * AMBIENT EMITTERS (driven from update, not from events)
   * ================================================================== */
  function emitExhaust(dt) {
    if (!SM.vehicle || !SM.vehicle.getY) return;
    var speed = SM.vehicle.getSpeed ? SM.vehicle.getSpeed() : 0;
    var load = SM.vehicle.getResistance ? SM.vehicle.getResistance() : 0;
    var rate = EXHAUST_RATE * (0.35 + Math.min(1, speed / C.VEHICLE_SPEED) * 0.65)
             * (1 + Math.min(1, load * 0.004) * 0.9)
             * (1 + overdrive * 1.4);
    exhaustAcc += rate * dt;
    while (exhaustAcc >= 1) {
      exhaustAcc -= 1;
      var vx = SM.vehicle.getX();
      var vy = SM.vehicle.getY();
      var side = Math.random() < 0.5 ? -1 : 1;
      var px = vx + side * (22 + Math.random() * 12);
      var py = vy + C.VEHICLE_BODY_LENGTH * 0.42 + Math.random() * 12;
      smoke(px, py,
            side * (10 + Math.random() * 26) - (SM.vehicle.getLateralSpeed ? SM.vehicle.getLateralSpeed() * 0.25 : 0),
            60 + Math.random() * 70,
            9 + Math.random() * 8);
      // Overdrive turns the exhaust into flame.
      if (overdrive > 0.35 && Math.random() < overdrive * 0.6) {
        sparksDir(px, py, 3, 2, 220, 0, 1, 0.5);
      }
    }
  }

  function emitGrind(dt) {
    if (!SM.vehicle || !SM.vehicle.getResistance) return;
    var load = Math.min(1, SM.vehicle.getResistance() * 0.0055);
    if (load <= 0.02) { grindAcc = 0; return; }
    grindAcc += GRIND_SPARK_RATE * load * dt;
    while (grindAcc >= 1) {
      grindAcc -= 1;
      var half = (SM.vehicle.getBladeWidth ? SM.vehicle.getBladeWidth() : 140) * 0.5;
      var px = SM.vehicle.getX() + (Math.random() * 2 - 1) * half;
      var py = SM.vehicle.getBladeFrontY ? SM.vehicle.getBladeFrontY() : SM.vehicle.getY();
      sparksDir(px, py, 1, 1, 210 + load * 260, (px < SM.vehicle.getX() ? -0.5 : 0.5), 1, 1.0);
    }
  }

  function emitOverdrive(dt) {
    if (overdrive <= 0.02) { streakAcc = 0; return; }
    streakAcc += OVERDRIVE_STREAK_RATE * overdrive * dt;
    if (streakAcc < 1) return;
    var b = SM.camera.getViewBounds();
    var w = b.maxX - b.minX, h = b.maxY - b.minY;
    while (streakAcc >= 1) {
      streakAcc -= 1;
      // Speed lines sweep down the screen past the machine.
      streak(b.minX + Math.random() * w, b.minY - 20 + Math.random() * h * 0.4,
             0, 900 + Math.random() * 700,
             60 + Math.random() * 90, 0.26 + Math.random() * 0.2,
             255, 190 + (Math.random() * 60) | 0, 120);
    }
  }

  function emitFireworks(dt) {
    if (zoneLevel < 4) return;
    fireworkTimer -= dt;
    if (fireworkTimer > 0) return;
    fireworkTimer = FIREWORK_MIN + Math.random() * (FIREWORK_MAX - FIREWORK_MIN);
    var b = SM.camera.getViewBounds();
    var px = b.minX + 80 + Math.random() * Math.max(20, (b.maxX - b.minX) - 160);
    var py = b.minY + 40 + Math.random() * Math.max(20, (b.maxY - b.minY) * 0.6);
    var mat = 3 + ((Math.random() * 4) | 0);        // gold..rare
    if (mat >= matCount) mat = matCount - 1;
    burst(px, py, mat, 0.5 + Math.random() * 0.5, false);
  }

  function flushCombo(dt) {
    if (comboCount === 0) return;
    comboTimer -= dt;
    comboHold += dt;
    if (comboTimer > 0 && comboHold < COMBO_MAX_HOLD) return;

    var v = Math.round(comboValue);
    if (v > 0) {
      // Bigger hauls get bigger, hotter text.
      var mag = v >= 2000 ? 3 : v >= 500 ? 2 : v >= 120 ? 1 : 0;
      var size = POPUP_FONT + mag * 5 + Math.min(4, comboCount * 0.25);
      if (size > POPUP_FONT_MAX) size = POPUP_FONT_MAX;
      var r = 255, g = 210, b = 70;
      if (mag === 1) { r = 255; g = 226; b = 120; }
      else if (mag === 2) { r = 190; g = 250; b = 255; }
      else if (mag === 3) { r = 255; g = 255; b = 255; }

      var vx = SM.vehicle && SM.vehicle.getX ? SM.vehicle.getX() : comboX;
      var vy = SM.vehicle && SM.vehicle.getY ? SM.vehicle.getY() : comboY;
      var half = (SM.vehicle && SM.vehicle.getWidth ? SM.vehicle.getWidth() : 140) * 0.5;
      // Alternate flanks and stay clear of the rig, so a torrent of popups
      // never sits on top of the machine you are trying to watch.
      comboSide = -comboSide;
      var px = vx + comboSide * (half + POPUP_CLEARANCE + size * 1.6);
      var lim = C.LANE_HALF_WIDTH - 70;
      if (px > lim) px = vx - (half + POPUP_CLEARANCE);
      if (px < -lim) px = vx + (half + POPUP_CLEARANCE);
      popup(px, vy - 10 + (Math.random() - 0.5) * 20, '+' + v, size, r, g, b);
      if (mag >= 3) glint(vx, vy, 46, 0.24, r, g, b, true);
    }
    comboValue = 0; comboCount = 0; comboTimer = 0; comboHold = 0;
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    buildTextures();
    if (!subscribed) {
      subscribed = true;
      SM.events.on('material:destroyed', onDestroyed);
      SM.events.on('material:hit', onHit);
      SM.events.on('resource:collected', onCollected);
      SM.events.on('impact:heavy', onHeavy);
      SM.events.on('upgrade:applied', onUpgrade);
      SM.events.on('vehicle:transform', onTransform);
      SM.events.on('pulse:fired', onPulse);
      SM.events.on('gate:passed', onGate);
      SM.events.on('overdrive:start', onOverdriveStart);
      SM.events.on('overdrive:end', onOverdriveEnd);
      SM.events.on('zone:entered', onZone);
      SM.events.on('level:complete', onComplete);
      SM.events.on('multiplier:changed', onMultiplier);
    }
    reset();
  }

  function reset() {
    freeCount = 0;
    actCount = 0;
    for (var i = CAP - 1; i >= 0; i--) { freeStack[freeCount++] = i; fText[i] = null; }
    budget = C.FX_BUDGET_PER_STEP;
    ringCd = 0;
    glintCd = 0;
    destroysThisStep = 0;
    comboSide = 1;
    clock = 0;
    exhaustAcc = grindAcc = streakAcc = 0;
    fireworkTimer = 0;
    comboValue = comboCount = comboTimer = comboHold = 0;
    valueMult = 1;
    overdrive = overdriveTarget = overdriveLeft = 0;
    flashAmt = 0;
    zoneKind = 'opening';
    zoneLevel = 0;
  }

  function update(dt) {
    clock += dt;

    /* --- sustained states ------------------------------------------- */
    if (overdriveLeft > 0) {
      overdriveLeft -= dt;
      if (overdriveLeft <= 0) overdriveTarget = 0;
    }
    overdrive += (overdriveTarget - overdrive) * Math.min(1, dt * 4.5);
    if (overdrive < 0.002) overdrive = 0;

    if (flashAmt > 0) {
      flashAmt -= dt * 2.6;
      if (flashAmt < 0) flashAmt = 0;
    }
    if (ringCd > 0) ringCd -= dt;
    if (glintCd > 0) glintCd -= dt;

    /* --- integrate the pool ------------------------------------------ */
    var k = 0;
    while (k < actCount) {
      var i = actList[k];
      fLife[i] -= dt;
      if (fLife[i] <= 0) { release(i); continue; }   // swap-in lands on k: recheck

      var t = fType[i];
      if (t === RING || t === FLASH || t === GLINT) { k++; continue; }

      var drag = t === SPARK ? SPARK_DRAG
               : t === CHIP ? CHIP_DRAG
               : t === SMOKE ? SMOKE_DRAG
               : t === STREAK ? STREAK_DRAG
               : t === TEXT ? 1.8
               : DUST_DRAG;
      var d = Math.exp(-drag * dt);
      fvx[i] *= d; fvy[i] *= d;
      fx[i] += fvx[i] * dt;
      fy[i] += fvy[i] * dt;

      if (t === DUST || t === SMOKE) {
        fRot[i] += fRotV[i] * dt;
        fSize[i] += fA[i] * dt;                      // puffs bloom outward
      } else if (t === CHIP) {
        fRot[i] += fRotV[i] * dt;
      } else if (t === TEXT) {
        if (fA[i] < 1) { fA[i] += dt * 7; if (fA[i] > 1) fA[i] = 1; }
      }
      k++;
    }

    /* --- ambient emitters -------------------------------------------- */
    emitExhaust(dt);
    emitGrind(dt);
    emitOverdrive(dt);
    emitFireworks(dt);
    flushCombo(dt);

    /* --- refill the spend allowance for the next step ------------------ */
    budget = C.FX_BUDGET_PER_STEP;
    destroysThisStep = 0;
  }

  /* =====================================================================
   * RENDER — grouped by blend mode so we flip composite state twice, total.
   * main.js calls this INSIDE the camera transform, so everything below is
   * world space (including the two full-view overlay rects).
   * ================================================================== */
  function render(ctx) {
    var i, k, a, s, img;

    if (actCount) {
      /* ---- pass 1: smoke + dust (normal blend, softest first) -------- */
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== SMOKE) continue;
        a = fLife[i] / fMax[i];
        ctx.globalAlpha = a * a * 0.5;
        s = fSize[i];
        ctx.drawImage(smokeTex, fx[i] - s, fy[i] - s, s * 2, s * 2);
      }
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== DUST) continue;
        a = fLife[i] / fMax[i];
        ctx.globalAlpha = a * 0.75;
        s = fSize[i];
        img = puffs[fMat[i]] || whitePuff;
        ctx.drawImage(img, fx[i] - s, fy[i] - s, s * 2, s * 2);
      }

      /* ---- pass 2: chips (normal blend, opaque, on top of the dust) --- */
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== CHIP) continue;
        a = fLife[i] / fMax[i];
        ctx.globalAlpha = a > 0.35 ? 1 : a / 0.35;
        s = fSize[i];
        img = chipTex[fMat[i]];
        if (!img) continue;
        var fr = ((fRot[i] * (CHIP_FRAMES / TAU)) | 0) % CHIP_FRAMES;
        if (fr < 0) fr += CHIP_FRAMES;
        ctx.drawImage(img, fr * CHIP_TEX, 0, CHIP_TEX, CHIP_TEX,
                      fx[i] - s, fy[i] - s, s * 2, s * 2);
      }

      /* ---- pass 3: everything additive ------------------------------- */
      ctx.globalCompositeOperation = 'lighter';

      // sparks + streaks: one path batch per colour
      var lastCol = -1, open = false;
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.2;
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        var tp = fType[i];
        if (tp !== SPARK && tp !== STREAK) continue;
        var col = (fR[i] << 16) | (fG[i] << 8) | fB[i];
        if (col !== lastCol) {
          if (open) ctx.stroke();
          ctx.strokeStyle = 'rgb(' + fR[i] + ',' + fG[i] + ',' + fB[i] + ')';
          ctx.beginPath();
          open = true;
          lastCol = col;
        }
        a = fLife[i] / fMax[i];
        ctx.globalAlpha = tp === STREAK ? a * a * 0.85 : a;
        var len = tp === STREAK ? fSize[i] * a : fSize[i] * (0.4 + a);
        var vxn = fvx[i], vyn = fvy[i];
        var vl = Math.sqrt(vxn * vxn + vyn * vyn) || 1;
        ctx.moveTo(fx[i], fy[i]);
        ctx.lineTo(fx[i] - (vxn / vl) * len, fy[i] - (vyn / vl) * len);
      }
      if (open) ctx.stroke();

      // rings / shockwaves
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== RING) continue;
        a = fLife[i] / fMax[i];
        var grow = 1 - a;
        var rad = fSize[i] * (0.35 + grow * fA[i]);
        var fat = fMat[i] === 1;
        ctx.globalAlpha = a * (fat ? 0.95 : 0.85);
        ctx.strokeStyle = 'rgb(' + fR[i] + ',' + fG[i] + ',' + fB[i] + ')';
        ctx.lineWidth = fat ? (3 + 16 * a * a) : (2 + 7 * a);
        ctx.beginPath();
        ctx.arc(fx[i], fy[i], rad, 0, TAU);
        ctx.stroke();
        if (fat && a > 0.55) {
          // leading edge highlight while the wave is young
          ctx.globalAlpha = (a - 0.55) * 1.6;
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(fx[i], fy[i], rad * 1.03, 0, TAU);
          ctx.stroke();
        }
      }

      // flashes + glints
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        var t2 = fType[i];
        if (t2 === FLASH) {
          a = fLife[i] / fMax[i];
          ctx.globalAlpha = a;
          var fs = fSize[i] * (1.6 - a * 0.6);
          ctx.drawImage(whitePuff, fx[i] - fs, fy[i] - fs, fs * 2, fs * 2);
        } else if (t2 === GLINT) {
          a = fLife[i] / fMax[i];
          // snap open, fade out
          var ga = a > 0.75 ? (1 - a) * 4 : a / 0.75;
          ctx.globalAlpha = ga;
          var gs = fSize[i] * (0.5 + (1 - a) * 0.9);
          ctx.drawImage(starTex, fx[i] - gs, fy[i] - gs, gs * 2, gs * 2);
        }
      }

      ctx.globalCompositeOperation = 'source-over';

      /* ---- pass 4: floating text ------------------------------------- */
      var didText = false;
      for (k = 0; k < actCount; k++) {
        i = actList[k];
        if (fType[i] !== TEXT || !fText[i]) continue;
        if (!didText) {
          didText = true;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineJoin = 'round';
        }
        a = fLife[i] / fMax[i];
        // easeOutBack pop-in on scale, linear fade at the tail
        var ph = fA[i];
        var sc = ph < 1 ? (0.4 + ph * ph * (2.2 - 1.2 * ph)) : 1;
        ctx.globalAlpha = a > 0.42 ? 1 : a / 0.42;
        ctx.font = fontFor(fSize[i] * sc);
        ctx.lineWidth = Math.max(2, fSize[i] * 0.16);
        ctx.strokeStyle = 'rgba(0,0,0,0.72)';
        ctx.strokeText(fText[i], fx[i], fy[i]);
        ctx.fillStyle = 'rgb(' + fR[i] + ',' + fG[i] + ',' + fB[i] + ')';
        ctx.fillText(fText[i], fx[i], fy[i]);
      }
      if (didText) {
        // Leave the context the way we found it: terrain.js and upgrades.js
        // also draw text and must not inherit our alignment.
        ctx.lineJoin = 'miter';
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
      ctx.lineCap = 'butt';
    }

    /* ---- pass 5: full-view overlays (still world space) -------------- */
    if (overdrive > 0.01 || flashAmt > 0.002) {
      var b = SM.camera.getViewBounds();
      var bw = b.maxX - b.minX, bh = b.maxY - b.minY;
      ctx.globalCompositeOperation = 'lighter';
      if (overdrive > 0.01) {
        // Warm heat grade — deliberately weak so the lane stays readable.
        var pulse = 0.72 + 0.28 * Math.sin(clock * 9.0);
        ctx.globalAlpha = GRADE_MAX_ALPHA * overdrive * pulse;
        ctx.fillStyle = '#ff7a24';
        ctx.fillRect(b.minX, b.minY, bw, bh);
      }
      if (flashAmt > 0.002) {
        ctx.globalAlpha = flashAmt;
        ctx.fillStyle = 'rgb(' + flashR + ',' + flashG + ',' + flashB + ')';
        ctx.fillRect(b.minX, b.minY, bw, bh);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.globalAlpha = 1;
  }

  function getCount() { return actCount; }
  function getIntensity() { return overdrive; }
  function getZoneLevel() { return zoneLevel; }

  return {
    init: init,
    reset: reset,
    update: update,
    render: render,
    // contract
    dust: dust,
    sparks: sparks,
    ring: ring,
    flash: flash,
    getCount: getCount,
    // additions
    sparksDir: sparksDir,
    chips: chips,
    shock: shock,
    glint: glint,
    smoke: smoke,
    streak: streak,
    popup: popup,
    burst: burst,
    screenFlash: screenFlash,
    getIntensity: getIntensity,
    getZoneLevel: getZoneLevel
  };
})();
