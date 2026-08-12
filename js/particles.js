/* =============================================================================
 * SUPERMINE — js/particles.js          *** THE HEART OF THE GAME ***
 * -----------------------------------------------------------------------------
 * >>> THIS FILE IS FROZEN after Phase 1. <<<
 * It deliberately contains ZERO knowledge of specific materials — everything it
 * needs is read from SM.materials. Agent 2 adds materials as DATA only.
 *
 * ARCHITECTURE
 * ---------------------------------------------------------------------------
 * Storage is "struct of arrays": one pre-allocated typed array per attribute,
 * indexed by particle slot. No objects, no garbage, no per-frame allocation on
 * any hot path. Capacity is fixed at SM.config.PARTICLE_CAPACITY.
 *
 * Three index lists are maintained with O(1) swap-remove:
 *   freeStack  — slots available for reuse (the object pool)
 *   activeList — every live particle, in arbitrary order (used for the grid,
 *                despawning and rendering)
 *   dynList    — only the particles that need integration each step
 *                (LOOSE + COLLECTED). The dense field of SOLID terrain never
 *                appears here, so the physics cost tracks debris count, not
 *                total particle count. This is the single most important
 *                performance decision in the file.
 *
 * SPATIAL HASH
 *   A uniform grid of GRID_COLS x GRID_ROWS cells of GRID_CELL world units.
 *   Cell coordinates are wrapped with a bitmask, so the grid is effectively an
 *   infinite tiling of a finite table — no allocation as the world scrolls.
 *   The wrap footprint (2944 x 5888 units) is far larger than the live streaming
 *   window (~1280 x ~1300), so two different world cells can never alias.
 *   Rebuilt once per simulation step with a head/next singly-linked list:
 *     cellHead[c] -> particle -> cellNext[p] -> particle -> ... -> -1
 *
 * STATES
 *   FREE      0  in the pool
 *   SOLID     1  embedded terrain. Never integrated, never moves. Accumulates
 *                damage from the cutter until hp <= 0, then BREAKS.
 *   LOOSE     2  tumbling debris. Integrated, collides, sleeps when settled.
 *   COLLECTED 3  flying to the collector. Ghost: no collision, homing only.
 *
 * SLEEPING
 *   A LOOSE particle whose speed stays under SLEEP_SPEED for SLEEP_TIME
 *   seconds goes to sleep: velocity zeroed, integration and relaxation skipped.
 *   It stays in the grid so it still acts as an obstacle. Any awake particle
 *   that pushes into it wakes it again (see the relaxation loop).
 *
 * INTEGRATION ORDER PER STEP
 *   1. integrate dynamics (drag, move, walls, vehicle body, magnet capture)
 *   2. rebuild the spatial hash from post-move positions
 *   3. RELAX_ITERATIONS passes of positional correction (+ one velocity
 *      response pass on iteration 0)
 *   4. sleep bookkeeping
 *   The hash is therefore always consistent with the positions the cutter will
 *   query on the following step.
 *
 * EVENTS EMITTED (payload objects are REUSED — read them immediately, never store)
 *   material:hit        {material, matIndex, x, y, intensity}   (rate limited)
 *   material:destroyed  {material, matIndex, x, y, value}
 *   resource:collected  {material, matIndex, x, y, value}
 *   impact:heavy        {strength, x, y}                        (max 1 / step)
 * ========================================================================== */

var SM = SM || {};

SM.particles = (function () {
  'use strict';

  var C = SM.config;

  /* --- states ------------------------------------------------------- */
  var FREE = 0, SOLID = 1, LOOSE = 2, COLLECTED = 3;

  var CAP = C.PARTICLE_CAPACITY;
  var TAU = Math.PI * 2;

  /* -------------------------------------------------------------------
   * PARTICLE STORAGE (struct of arrays)
   * ---------------------------------------------------------------- */
  var pX = new Float32Array(CAP);
  var pY = new Float32Array(CAP);
  var vX = new Float32Array(CAP);
  var vY = new Float32Array(CAP);
  var pR = new Float32Array(CAP);      // collision + draw radius (quantised)
  var pHp = new Float32Array(CAP);     // remaining hardness (SOLID only)
  var pVal = new Float32Array(CAP);    // currency carried
  var pRot = new Float32Array(CAP);    // visual angle
  var pRotV = new Float32Array(CAP);   // visual angular velocity
  var pInvM = new Float32Array(CAP);   // inverse mass for the solver
  var pSleep = new Float32Array(CAP);  // seconds spent below SLEEP_SPEED
  var pAge = new Float32Array(CAP);    // seconds since spawn (LOOSE/COLLECTED)

  var sState = new Uint8Array(CAP);
  var sMat = new Uint8Array(CAP);
  var sShade = new Uint8Array(CAP);    // sprite shade variant
  var sSize = new Uint8Array(CAP);     // sprite size bucket
  var sAsleep = new Uint8Array(CAP);

  /* --- pool + index lists ------------------------------------------- */
  var freeStack = new Int32Array(CAP);
  var freeCount = 0;

  var activeList = new Int32Array(CAP);
  var activeSlot = new Int32Array(CAP);
  var activeCount = 0;

  var dynList = new Int32Array(CAP);
  var dynSlot = new Int32Array(CAP);
  var dynCount = 0;

  var looseAlive = 0;                  // LOOSE only (excludes COLLECTED)
  var solidAlive = 0;

  /* -------------------------------------------------------------------
   * SPATIAL HASH
   * ---------------------------------------------------------------- */
  var COLS = C.GRID_COLS, ROWS = C.GRID_ROWS;
  var COLMASK = COLS - 1, ROWMASK = ROWS - 1;
  var NCELLS = COLS * ROWS;
  var cellHead = new Int32Array(NCELLS);
  var cellNext = new Int32Array(CAP);
  var INV_CELL = 1 / C.GRID_CELL;
  var HASH_OFFS = 1 << 20;             // keeps the truncation positive

  /* -------------------------------------------------------------------
   * PER-MATERIAL CACHES  (flat arrays -> no property lookups in hot loops)
   * Rebuilt by init(), so new materials added by Agent 2 are picked up
   * automatically.
   * ---------------------------------------------------------------- */
  var NMAT = 0;
  var mHardness, mValue, mDebrisValue, mDebrisCount, mRest, mDamp, mInvDens,
      mDebrisScale, mSpeedMin, mSpeedSpan, mSpread, mBackBias,
      mSpinMin, mSpinSpan, mJitter, mRadMin, mRadSpan;

  /* -------------------------------------------------------------------
   * SPRITE ATLASES — one canvas per material, laid out as
   *   columns = SPRITE_ROT_STEPS      (baked rotations)
   *   rows    = SIZE_STEPS * SHADE_STEPS
   * Baking rotations means the renderer never touches ctx.rotate().
   * ---------------------------------------------------------------- */
  // atlases[matIndex] = {
  //   canvas, cell[NSIZE], half[NSIZE], rowY[NSIZE*NSHADE]
  // }
  // Cell size varies per size bucket (and per material, because glowing
  // materials need halo margin). Drawing a 11px cell for a 2.6-radius chip
  // instead of a 34px one removes ~90% of the blended pixels for debris.
  var atlases = [];
  var bucketRadius = null;             // Float32Array of quantised radii
  var NSIZE = C.SPRITE_SIZE_STEPS;
  var NSHADE = C.SPRITE_SHADE_STEPS;
  var NROT = C.SPRITE_ROT_STEPS;
  var ROT_TO_IDX = NROT / TAU;

  /* --- render buckets (pre-allocated, reused every frame) ------------ */
  var matBucket = [];                  // [matIndex] -> Int32Array
  var matBucketN = null;               // Int32Array counts
  var drawDyn = new Int32Array(CAP);   // loose + collected, drawn last
  var drawDynN = 0;

  /* -------------------------------------------------------------------
   * EXTERNAL INPUTS pushed in by the vehicle each step
   * ---------------------------------------------------------------- */
  var colX = 0, colY = 0, colR = 0, colR2 = 0;
  var colActive = false;

  var bodyActive = false;
  var bodyX = 0, bodyY = 0, bodyHW = 0, bodyHH = 0, bodyVX = 0, bodyVY = 0;

  /* --- reused event payloads (NEVER stored by handlers) -------------- */
  var evHit = { material: '', matIndex: 0, x: 0, y: 0, intensity: 0 };
  var evDestroyed = { material: '', matIndex: 0, x: 0, y: 0, value: 0 };
  var evCollected = { material: '', matIndex: 0, x: 0, y: 0, value: 0 };
  var evHeavy = { strength: 0, x: 0, y: 0 };

  /* --- reused return object for damageSolidInRect -------------------- */
  var cutResult = { broken: 0, damaged: 0, resistance: 0, value: 0 };

  /* --- per-step accumulators ----------------------------------------- */
  var HIT_EVENTS_PER_STEP = 3;
  var hitEventsThisStep = 0;
  var heavyAccum = 0, heavyX = 0, heavyY = 0;

  var statsOut = { active: 0, solid: 0, loose: 0, collected: 0, free: 0 };

  /* =====================================================================
   * COLOUR HELPERS (sprite baking only — not on any hot path)
   * ================================================================== */
  function parseColor(css) {
    var r = 128, g = 128, b = 128;
    if (typeof css === 'string' && css.charAt(0) === '#') {
      var h = css.slice(1);
      if (h.length === 3) {
        r = parseInt(h.charAt(0) + h.charAt(0), 16);
        g = parseInt(h.charAt(1) + h.charAt(1), 16);
        b = parseInt(h.charAt(2) + h.charAt(2), 16);
      } else if (h.length >= 6) {
        r = parseInt(h.substr(0, 2), 16);
        g = parseInt(h.substr(2, 2), 16);
        b = parseInt(h.substr(4, 2), 16);
      }
    }
    return [r, g, b];
  }
  function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v | 0); }
  function rgbCss(c, f) {
    return 'rgb(' + clamp255(c[0] * f) + ',' + clamp255(c[1] * f) + ',' + clamp255(c[2] * f) + ')';
  }
  function rgbaCss(c, f, a) {
    return 'rgba(' + clamp255(c[0] * f) + ',' + clamp255(c[1] * f) + ',' + clamp255(c[2] * f) + ',' + a + ')';
  }

  /** Deterministic PRNG so the atlas looks the same every run. */
  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* =====================================================================
   * SPRITE ATLAS BAKING
   * The silhouette family is chosen from material.shape, which materials.js
   * derives from the break style. Colours come from material.colors.
   * ================================================================== */
  function buildSilhouette(rng, shape, r) {
    var n, i, a, rr, sx = 1, sy = 1;
    if (shape === 'shard') { n = 5; sx = 1.28; sy = 0.72; }
    else if (shape === 'chunk') { n = 7; }
    else { n = 9; }
    var pts = new Float64Array(n * 2);
    for (i = 0; i < n; i++) {
      a = (i / n) * TAU + rng() * 0.22;
      if (shape === 'shard') rr = r * (0.52 + rng() * 0.72);
      else if (shape === 'chunk') rr = r * (0.74 + rng() * 0.40);
      else rr = r * (0.90 + rng() * 0.14);
      pts[i * 2] = Math.cos(a) * rr * sx;
      pts[i * 2 + 1] = Math.sin(a) * rr * sy;
    }
    return pts;
  }

  function tracePolygon(ctx, pts, ang, scale) {
    var ca = Math.cos(ang), sa = Math.sin(ang);
    var n = pts.length >> 1;
    ctx.beginPath();
    for (var i = 0; i < n; i++) {
      var x = pts[i * 2] * scale, y = pts[i * 2 + 1] * scale;
      var rx = x * ca - y * sa;
      var ry = x * sa + y * ca;
      if (i === 0) ctx.moveTo(rx, ry); else ctx.lineTo(rx, ry);
    }
    ctx.closePath();
  }

  function bakeAtlas(mat) {
    var base = parseColor(mat.colors[0]);
    var dark = parseColor(mat.colors[1] || mat.colors[0]);
    var lite = parseColor(mat.colors[2] || mat.colors[0]);

    // Glowing materials need room for the halo; plain rock only needs a couple
    // of pixels for the offset shadow and the rim stroke.
    // These multipliers are FILL RATE. With ~5000 sprites on screen every extra
    // pixel of margin costs 5000 * (2r*dm)^2 blended pixels per frame, so keep
    // them as tight as the artwork allows.
    var margin = mat.glow ? 1.58 : 1.16;

    var cellArr = new Float32Array(NSIZE);
    var halfArr = new Float32Array(NSIZE);
    var rowY = new Float32Array(NSIZE * NSHADE);

    var maxCell = 0, totalH = 0, si, sh, ri;
    for (si = 0; si < NSIZE; si++) {
      var c = Math.ceil(bucketRadius[si] * 2 * margin) + 5;
      cellArr[si] = c;
      halfArr[si] = c * 0.5;
      if (c > maxCell) maxCell = c;
      for (sh = 0; sh < NSHADE; sh++) {
        rowY[si * NSHADE + sh] = totalH;
        totalH += c;
      }
    }

    var cv = document.createElement('canvas');
    cv.width = NROT * maxCell;
    cv.height = totalH;
    var g = cv.getContext('2d');

    // Brightness multiplier per shade row — cheap "different rocks" variety.
    var shadeMul = [0.80, 1.0, 1.18];

    for (si = 0; si < NSIZE; si++) {
      var r = bucketRadius[si];
      var cell = cellArr[si], half = halfArr[si];
      for (sh = 0; sh < NSHADE; sh++) {
        var f = shadeMul[sh % shadeMul.length];
        // Stable per-(material,size,shade) silhouette.
        var rng = mulberry32(mat.index * 7919 + si * 131 + sh * 17 + 1);
        var pts = buildSilhouette(rng, mat.shape, r);
        var row = si * NSHADE + sh;

        for (ri = 0; ri < NROT; ri++) {
          var ang = (ri / NROT) * TAU;
          var cx = ri * cell + half;
          var cy = rowY[row] + half;

          g.save();
          g.translate(cx, cy);

          // --- glow halo (baked in: zero extra draw calls at runtime) ----
          if (mat.glow) {
            var gr = g.createRadialGradient(0, 0, r * 0.2, 0, 0, r * 1.52);
            gr.addColorStop(0, rgbaCss(lite, f, 0.50));
            gr.addColorStop(0.45, rgbaCss(base, f, 0.24));
            gr.addColorStop(1, rgbaCss(base, f, 0));
            g.fillStyle = gr;
            g.beginPath();
            g.arc(0, 0, r * 1.52, 0, TAU);
            g.fill();
          }

          // --- contact shadow, offset down-right for a sense of depth ----
          g.save();
          g.translate(1.3, 1.9);
          tracePolygon(g, pts, ang, 1.0);
          g.fillStyle = 'rgba(0,0,0,0.30)';
          g.fill();
          g.restore();

          // --- body -------------------------------------------------------
          tracePolygon(g, pts, ang, 1.0);
          var bg = g.createLinearGradient(-r, -r, r * 0.6, r);
          bg.addColorStop(0, rgbCss(lite, f * 0.92));
          bg.addColorStop(0.45, rgbCss(base, f));
          bg.addColorStop(1, rgbCss(dark, f));
          g.fillStyle = bg;
          g.fill();

          // --- rim --------------------------------------------------------
          g.lineWidth = Math.max(0.7, r * 0.13);
          g.strokeStyle = rgbaCss(dark, f * 0.75, 0.85);
          g.stroke();

          // --- specular facet --------------------------------------------
          g.save();
          g.translate(-r * 0.24, -r * 0.28);
          tracePolygon(g, pts, ang + 0.4, 0.46);
          g.fillStyle = rgbaCss(lite, f, mat.glow ? 0.80 : 0.55);
          g.fill();
          g.restore();

          g.restore();
        }
      }
    }
    return { canvas: cv, cell: cellArr, half: halfArr, rowY: rowY };
  }

  function buildAtlases() {
    bucketRadius = new Float32Array(NSIZE);
    var lo = C.SPRITE_MIN_RADIUS, hi = C.SPRITE_MAX_RADIUS;
    for (var i = 0; i < NSIZE; i++) {
      bucketRadius[i] = NSIZE === 1 ? hi : lo + (hi - lo) * (i / (NSIZE - 1));
    }
    atlases.length = 0;
    for (var m = 0; m < MATS().length; m++) atlases.push(bakeAtlas(MATS()[m]));
  }

  function MATS() { return SM.materials.list; }

  /** Quantise a requested radius onto the nearest baked sprite bucket. */
  function sizeBucketFor(r) {
    var lo = C.SPRITE_MIN_RADIUS, hi = C.SPRITE_MAX_RADIUS;
    var t = (r - lo) / (hi - lo);
    var k = Math.round(t * (NSIZE - 1));
    if (k < 0) k = 0; else if (k > NSIZE - 1) k = NSIZE - 1;
    return k;
  }

  /* =====================================================================
   * MATERIAL CACHE
   * ================================================================== */
  function buildMaterialCache() {
    var list = MATS();
    NMAT = list.length;
    mHardness = new Float32Array(NMAT);
    mValue = new Float32Array(NMAT);
    mDebrisValue = new Float32Array(NMAT);
    mDebrisCount = new Int32Array(NMAT);
    mRest = new Float32Array(NMAT);
    mDamp = new Float32Array(NMAT);
    mInvDens = new Float32Array(NMAT);
    mDebrisScale = new Float32Array(NMAT);
    mSpeedMin = new Float32Array(NMAT);
    mSpeedSpan = new Float32Array(NMAT);
    mSpread = new Float32Array(NMAT);
    mBackBias = new Float32Array(NMAT);
    mSpinMin = new Float32Array(NMAT);
    mSpinSpan = new Float32Array(NMAT);
    mJitter = new Float32Array(NMAT);
    mRadMin = new Float32Array(NMAT);
    mRadSpan = new Float32Array(NMAT);

    for (var i = 0; i < NMAT; i++) {
      var m = list[i], s = m.style;
      mHardness[i] = m.hardness;
      mValue[i] = m.value;
      mDebrisValue[i] = m.debrisValue;
      mDebrisCount[i] = m.debrisCount;
      mRest[i] = m.restitution;
      mInvDens[i] = m.invDensity;
      mDebrisScale[i] = s.debrisScale;
      mSpeedMin[i] = s.speed[0];
      mSpeedSpan[i] = s.speed[1] - s.speed[0];
      mSpread[i] = s.spread;
      mBackBias[i] = s.backBias;
      mSpinMin[i] = s.spin[0];
      mSpinSpan[i] = s.spin[1] - s.spin[0];
      mJitter[i] = s.jitter;
      mRadMin[i] = m.radius[0];
      mRadSpan[i] = m.radius[1] - m.radius[0];
      // Per-step damping factor: friction and break-style drag combined.
      var rate = C.LOOSE_LINEAR_DRAG * s.drag * m.friction;
      mDamp[i] = Math.exp(-rate * C.FIXED_DT);
    }

    // Render buckets sized to capacity so they can never overflow.
    matBucket.length = 0;
    for (var b = 0; b < NMAT; b++) matBucket.push(new Int32Array(CAP));
    matBucketN = new Int32Array(NMAT);
  }

  /* =====================================================================
   * POOL / LIST BOOKKEEPING  (all O(1))
   * ================================================================== */
  function addActive(i) { activeSlot[i] = activeCount; activeList[activeCount++] = i; }
  function removeActive(i) {
    var s = activeSlot[i];
    var last = activeList[--activeCount];
    activeList[s] = last;
    activeSlot[last] = s;
  }
  function addDyn(i) { dynSlot[i] = dynCount; dynList[dynCount++] = i; }
  function removeDyn(i) {
    var s = dynSlot[i];
    var last = dynList[--dynCount];
    dynList[s] = last;
    dynSlot[last] = s;
  }

  function alloc() {
    if (freeCount === 0) return -1;
    return freeStack[--freeCount];
  }

  /** Return a slot to the pool and unlink it from every list. */
  function free(i) {
    var st = sState[i];
    if (st === FREE) return;
    if (st === LOOSE) { looseAlive--; removeDyn(i); }
    else if (st === COLLECTED) { removeDyn(i); }
    else if (st === SOLID) { solidAlive--; }
    removeActive(i);
    sState[i] = FREE;
    sAsleep[i] = 0;
    freeStack[freeCount++] = i;
  }

  /* =====================================================================
   * SPAWNING
   * ================================================================== */

  /**
   * Spawn an embedded terrain deposit.
   * @param {number} x world x
   * @param {number} y world y
   * @param {number} matIndex index into SM.materials.list
   * @param {number} [radiusOverride] optional explicit radius
   * @return {number} slot index, or -1 if the pool is exhausted
   */
  function spawnSolid(x, y, matIndex, radiusOverride) {
    var i = alloc();
    if (i < 0) return -1;
    if (matIndex < 0 || matIndex >= NMAT) matIndex = 0;

    var r = radiusOverride !== undefined
      ? radiusOverride
      : mRadMin[matIndex] + Math.random() * mRadSpan[matIndex];
    var bucket = sizeBucketFor(r);

    pX[i] = x; pY[i] = y;
    vX[i] = 0; vY[i] = 0;
    pR[i] = bucketRadius[bucket];
    pHp[i] = mHardness[matIndex];
    pVal[i] = mValue[matIndex];
    pRot[i] = Math.random() * TAU;
    pRotV[i] = 0;
    pInvM[i] = mInvDens[matIndex] / (pR[i] * pR[i]);
    pSleep[i] = 0;
    pAge[i] = 0;
    sState[i] = SOLID;
    sMat[i] = matIndex;
    sSize[i] = bucket;
    sShade[i] = (Math.random() * NSHADE) | 0;
    sAsleep[i] = 1;               // solids are conceptually always "asleep"
    solidAlive++;
    addActive(i);
    return i;
  }

  /**
   * Spawn a loose debris particle directly. Used by breakSolid() and available
   * to gameplay code (explosions, conveyor spills, decorative rubble...).
   */
  function spawnLoose(x, y, matIndex, vx, vy, radius, value) {
    if (looseAlive >= C.MAX_LOOSE) return -1;
    var i = alloc();
    if (i < 0) return -1;
    if (matIndex < 0 || matIndex >= NMAT) matIndex = 0;

    var bucket = sizeBucketFor(radius);
    pX[i] = x; pY[i] = y;
    pR[i] = bucketRadius[bucket];
    pVal[i] = value === undefined ? mDebrisValue[matIndex] : value;
    pHp[i] = 0;
    pRot[i] = Math.random() * TAU;
    pRotV[i] = (mSpinMin[matIndex] + Math.random() * mSpinSpan[matIndex]) * (Math.random() < 0.5 ? -1 : 1);
    pInvM[i] = mInvDens[matIndex] / (pR[i] * pR[i]);
    pSleep[i] = 0;
    pAge[i] = 0;
    sState[i] = LOOSE;
    sMat[i] = matIndex;
    sSize[i] = bucket;
    sShade[i] = (Math.random() * NSHADE) | 0;
    sAsleep[i] = 0;

    // Heavier material is thrown less far — density shows up as "weight".
    var w = mInvDens[matIndex] * 1.4;
    if (w > 1.4) w = 1.4;
    vX[i] = vx * w;
    vY[i] = vy * w;

    looseAlive++;
    addActive(i);
    addDyn(i);
    return i;
  }

  /**
   * Convert one SOLID deposit into debris and recycle the slot.
   * (ox, oy) is the impact origin: fragments are thrown away from it.
   */
  function breakSolid(i, ox, oy) {
    var m = sMat[i];
    var x = pX[i], y = pY[i], r = pR[i];

    // --- announce ------------------------------------------------------
    var mat = MATS()[m];
    evDestroyed.material = mat.id;
    evDestroyed.matIndex = m;
    evDestroyed.x = x;
    evDestroyed.y = y;
    evDestroyed.value = mValue[m];
    SM.events.emit('material:destroyed', evDestroyed);

    // Accumulate "how violent was this step" for a single impact:heavy.
    heavyAccum += mHardness[m];
    heavyX = x; heavyY = y;

    // --- direction away from the cutter --------------------------------
    var dx = x - ox, dy = y - oy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.0001) { dx = 0; dy = -1; } else { dx /= d; dy /= d; }
    // Blend in a "push it back past the machine" bias so debris lands inside
    // the collector radius instead of only flying forward.
    var bb = mBackBias[m];
    dx = dx * (1 - bb);
    dy = dy * (1 - bb) + bb;          // +y is behind the vehicle
    var dl = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= dl; dy /= dl;
    var baseAng = Math.atan2(dy, dx);

    // --- spawn fragments -----------------------------------------------
    var n = mDebrisCount[m];
    // Under debris pressure, shed fragments rather than dropping frames.
    if (looseAlive > C.MAX_LOOSE * 0.75) n = (n * 0.5) | 0;
    if (n < 1) n = 1;

    var childR = r * mDebrisScale[m];
    var spread = mSpread[m];
    var jit = mJitter[m] * r;

    for (var k = 0; k < n; k++) {
      var a = baseAng + (Math.random() - 0.5) * spread;
      var sp = mSpeedMin[m] + Math.random() * mSpeedSpan[m];
      var cx = x + (Math.random() - 0.5) * jit;
      var cy = y + (Math.random() - 0.5) * jit;
      spawnLoose(cx, cy, m,
        Math.cos(a) * sp, Math.sin(a) * sp,
        childR * (0.82 + Math.random() * 0.36),
        mDebrisValue[m]);
    }

    free(i);
  }

  /* =====================================================================
   * SPATIAL HASH
   * ================================================================== */
  function cellOf(x, y) {
    var gx = ((x * INV_CELL + HASH_OFFS) | 0) & COLMASK;
    var gy = ((y * INV_CELL + HASH_OFFS) | 0) & ROWMASK;
    return gy * COLS + gx;
  }

  /**
   * Rebuild the whole hash from the active list.
   * Cost: one memset of NCELLS int32 plus one pass over activeCount.
   * Called at the right moment inside update(); terrain.js calls it after a
   * bulk spawn so the cutter can see brand-new material on frame 1.
   */
  function rebuildGrid() {
    cellHead.fill(-1);
    for (var k = 0; k < activeCount; k++) {
      var i = activeList[k];
      var c = cellOf(pX[i], pY[i]);
      cellNext[i] = cellHead[c];
      cellHead[c] = i;
    }
  }

  /* =====================================================================
   * QUERIES
   * ================================================================== */

  /**
   * Visit every particle whose circle overlaps an axis-aligned rectangle.
   * fn(index) is called for each hit. Do NOT spawn or free inside fn unless
   * you understand the chain-capture trick used below.
   */
  function queryRect(minX, minY, maxX, maxY, fn) {
    var c0 = (minX * INV_CELL + HASH_OFFS) | 0;
    var c1 = (maxX * INV_CELL + HASH_OFFS) | 0;
    var r0 = (minY * INV_CELL + HASH_OFFS) | 0;
    var r1 = (maxY * INV_CELL + HASH_OFFS) | 0;
    for (var rr = r0; rr <= r1; rr++) {
      var rowBase = (rr & ROWMASK) * COLS;
      for (var cc = c0; cc <= c1; cc++) {
        var i = cellHead[rowBase + (cc & COLMASK)];
        while (i !== -1) {
          var next = cellNext[i];      // capture first: fn may recycle slot i
          var r = pR[i];
          if (pX[i] + r >= minX && pX[i] - r <= maxX &&
              pY[i] + r >= minY && pY[i] - r <= maxY) {
            fn(i);
          }
          i = next;
        }
      }
    }
  }

  /**
   * THE CUTTER. Apply `damage` hardness-points to every SOLID particle whose
   * circle overlaps the rectangle; break the ones that reach zero.
   *
   * @param ox,oy  impact origin used to aim the debris (usually blade centre)
   * @return reused object {broken, damaged, resistance, value}
   *         `resistance` is the summed hardness of material that SURVIVED —
   *         vehicle.js turns that into a slowdown so hard rock feels heavy.
   */
  function damageSolidInRect(minX, minY, maxX, maxY, damage, ox, oy) {
    cutResult.broken = 0;
    cutResult.damaged = 0;
    cutResult.resistance = 0;
    cutResult.value = 0;

    var c0 = (minX * INV_CELL + HASH_OFFS) | 0;
    var c1 = (maxX * INV_CELL + HASH_OFFS) | 0;
    var r0 = (minY * INV_CELL + HASH_OFFS) | 0;
    var r1 = (maxY * INV_CELL + HASH_OFFS) | 0;

    var sampleX = 0, sampleY = 0, sampleMat = -1;

    for (var rr = r0; rr <= r1; rr++) {
      var rowBase = (rr & ROWMASK) * COLS;
      for (var cc = c0; cc <= c1; cc++) {
        var i = cellHead[rowBase + (cc & COLMASK)];
        while (i !== -1) {
          // Capture the chain link BEFORE the slot can be recycled by a break.
          var next = cellNext[i];
          if (sState[i] === SOLID) {
            var r = pR[i];
            var x = pX[i], y = pY[i];
            if (x + r >= minX && x - r <= maxX && y + r >= minY && y - r <= maxY) {
              cutResult.damaged++;
              pHp[i] -= damage;
              if (pHp[i] <= 0) {
                cutResult.broken++;
                cutResult.value += mValue[sMat[i]];
                sampleX = x; sampleY = y; sampleMat = sMat[i];
                breakSolid(i, ox, oy);
              } else {
                // Still standing: this is what slows the machine down.
                cutResult.resistance += mHardness[sMat[i]];
                if (sampleMat < 0) { sampleX = x; sampleY = y; sampleMat = sMat[i]; }
              }
            }
          }
          i = next;
        }
      }
    }

    // Rate-limited grinding event — a few per step, never thousands.
    if (sampleMat >= 0 && hitEventsThisStep < HIT_EVENTS_PER_STEP) {
      hitEventsThisStep++;
      evHit.material = MATS()[sampleMat].id;
      evHit.matIndex = sampleMat;
      evHit.x = sampleX;
      evHit.y = sampleY;
      evHit.intensity = cutResult.damaged > 0 ? Math.min(1, cutResult.damaged / 28) : 0;
      SM.events.emit('material:hit', evHit);
    }

    return cutResult;
  }

  /**
   * Radial blast. Damages solids and shoves loose debris outward.
   * Provided for Agent 2's explosive upgrades; unused by the slice.
   */
  function explode(x, y, radius, damage, force) {
    var r2 = radius * radius;
    var minX = x - radius, maxX = x + radius;
    var minY = y - radius, maxY = y + radius;
    var c0 = (minX * INV_CELL + HASH_OFFS) | 0;
    var c1 = (maxX * INV_CELL + HASH_OFFS) | 0;
    var r0 = (minY * INV_CELL + HASH_OFFS) | 0;
    var r1 = (maxY * INV_CELL + HASH_OFFS) | 0;
    for (var rr = r0; rr <= r1; rr++) {
      var rowBase = (rr & ROWMASK) * COLS;
      for (var cc = c0; cc <= c1; cc++) {
        var i = cellHead[rowBase + (cc & COLMASK)];
        while (i !== -1) {
          var next = cellNext[i];
          var dx = pX[i] - x, dy = pY[i] - y;
          var d2 = dx * dx + dy * dy;
          if (d2 <= r2) {
            var falloff = 1 - Math.sqrt(d2) / radius;
            if (sState[i] === SOLID) {
              pHp[i] -= damage * falloff;
              if (pHp[i] <= 0) breakSolid(i, x, y);
            } else if (sState[i] === LOOSE) {
              var d = Math.sqrt(d2) || 1;
              vX[i] += (dx / d) * force * falloff;
              vY[i] += (dy / d) * force * falloff;
              sAsleep[i] = 0; pSleep[i] = 0;
            }
          }
          i = next;
        }
      }
    }
    evHeavy.strength = 1;
    evHeavy.x = x; evHeavy.y = y;
    SM.events.emit('impact:heavy', evHeavy);
  }

  /** Force everything loose inside a circle into the collector stream. */
  function collectInRadius(x, y, radius) {
    var r2 = radius * radius;
    for (var k = 0; k < dynCount; k++) {
      var i = dynList[k];
      if (sState[i] !== LOOSE) continue;
      var dx = pX[i] - x, dy = pY[i] - y;
      if (dx * dx + dy * dy <= r2) startCollecting(i);
    }
  }

  function startCollecting(i) {
    sState[i] = COLLECTED;
    looseAlive--;
    sAsleep[i] = 0;
    pSleep[i] = 0;
    pAge[i] = 0;
    // Keep a little of the original drift so the pull curves in instead of
    // snapping — this is most of what makes collection feel "magnetic".
    vX[i] *= 0.35;
    vY[i] *= 0.35;
    pRotV[i] = (Math.random() < 0.5 ? -1 : 1) * C.COLLECT_SPIN;
  }

  /* =====================================================================
   * EXTERNAL STATE SETTERS (called by vehicle.js every step)
   * ================================================================== */
  function setCollectorTarget(x, y, radius) {
    colX = x; colY = y; colR = radius; colR2 = radius * radius;
    colActive = true;
  }
  function clearCollectorTarget() { colActive = false; }

  function setVehicleBody(cx, cy, halfW, halfH, vx, vy) {
    bodyActive = true;
    bodyX = cx; bodyY = cy; bodyHW = halfW; bodyHH = halfH;
    bodyVX = vx; bodyVY = vy;
  }
  function clearVehicleBody() { bodyActive = false; }

  /* =====================================================================
   * SIMULATION STEP
   * ================================================================== */
  function update(dt) {
    hitEventsThisStep = 0;

    integrate(dt);
    rebuildGrid();
    relax(dt);

    // One aggregated heavy-impact event per step keeps handlers cheap.
    // The threshold is deliberately high: routine grinding must NOT fire this,
    // or the camera shake saturates and never lets go.
    if (heavyAccum > 18) {
      evHeavy.strength = Math.min(1, heavyAccum / 140);
      evHeavy.x = heavyX;
      evHeavy.y = heavyY;
      SM.events.emit('impact:heavy', evHeavy);
    }
    heavyAccum = 0;
  }

  /* --- 1. integration ------------------------------------------------ */
  function integrate(dt) {
    /* THE ONE DELIBERATE EXCEPTION TO THIS FILE'S FREEZE.
     *
     * These are the walls loose debris bounces off. They were hard-coded to the
     * classic lane, but an ADVENTURE shaft is wider (ADV.MINE_HALF_WIDTH 880 vs
     * LANE_HALF_WIDTH 640), so underground every fragment in the outer 240 units
     * of each side was snapped inward off a wall that is not drawn and is not
     * there — ore erupting from a wide cut visibly jumped towards the middle.
     *
     * Read ONCE PER STEP, not per particle, so the cost is a single guarded
     * function call against ~200 dynamic entries. Deliberately not a setter:
     * a setter is a second copy of this fact that some code path forgets to
     * update, and the bound would then be wrong for a whole descent. */
    var lane = C.LANE_HALF_WIDTH;
    if (SM.adv && SM.adv.isActive && SM.adv.isActive()) lane = C.ADV.MINE_HALF_WIDTH;
    var maxSpeed = C.MAX_SPEED;
    var snap2 = C.COLLECT_SNAP_DIST * C.COLLECT_SNAP_DIST;
    var collAcc = C.COLLECT_ACCEL;
    var collMax = C.COLLECT_MAX_SPEED;
    var sleepSpeed2 = C.SLEEP_SPEED * C.SLEEP_SPEED;

    // Iterate backwards: entries can be removed (collected / recycled).
    for (var k = dynCount - 1; k >= 0; k--) {
      if (k >= dynCount) continue;              // list shrank underneath us
      var i = dynList[k];
      var st = sState[i];
      pAge[i] += dt;

      /* ---------------- COLLECTED: homing magnet --------------------- *
       * STEERING, not a force. We compute a desired velocity vector each
       * step and lerp the real velocity toward it. That is critically
       * damped by construction, so the fragment always arrives instead of
       * orbiting the collector forever (which is exactly what a naive
       * "accelerate toward the target" implementation does).
       * --------------------------------------------------------------- */
      if (st === COLLECTED) {
        if (!colActive) { free(i); continue; }   // no machine: drop silently
        var dx = colX - pX[i], dy = colY - pY[i];
        var d2 = dx * dx + dy * dy;
        var d = Math.sqrt(d2);

        // Desired speed ramps hard — slow yank, then a whipping snap.
        var want = C.COLLECT_START_SPEED + collAcc * pAge[i];
        if (want > collMax) want = collMax;

        // Arrive if we are inside the snap radius OR would step past it.
        if (d2 <= snap2 || d <= want * dt) {
          var mi = sMat[i];
          evCollected.material = MATS()[mi].id;
          evCollected.matIndex = mi;
          evCollected.x = pX[i];
          evCollected.y = pY[i];
          evCollected.value = pVal[i];
          SM.events.emit('resource:collected', evCollected);
          free(i);
          continue;
        }

        var nx = dx / d, ny = dy / d;
        // Tangential bias that fades as it closes -> a curved, magnetic arc
        // rather than a dead-straight line.
        var sw = C.COLLECT_SWIRL * (d < 140 ? d / 140 : 1);
        var tvx = nx - ny * sw;
        var tvy = ny + nx * sw;
        var tl = Math.sqrt(tvx * tvx + tvy * tvy) || 1;
        var kk = 1 - Math.exp(-C.COLLECT_SEEK * dt);
        vX[i] += ((tvx / tl) * want - vX[i]) * kk;
        vY[i] += ((tvy / tl) * want - vY[i]) * kk;

        pX[i] += vX[i] * dt;
        pY[i] += vY[i] * dt;
        pRot[i] += pRotV[i] * dt;
        continue;
      }

      /* ---------------- LOOSE ---------------------------------------- */
      // Magnet capture. Fresh debris is IMMUNE for COLLECT_DELAY seconds so
      // it gets to erupt, tumble and bounce first — that grace window is what
      // makes destruction read as physical instead of as deletion.
      // Old settled debris has no immunity, so driving past a pile vacuums it.
      if (colActive && pAge[i] >= C.COLLECT_DELAY) {
        var mx = colX - pX[i], my = colY - pY[i];
        if (mx * mx + my * my <= colR2) {
          startCollecting(i);
          continue;
        }
      }

      if (sAsleep[i]) continue;                 // settled: nothing to do

      // drag
      var damp = mDamp[sMat[i]];
      vX[i] *= damp;
      vY[i] *= damp;

      // speed clamp (also guarantees displacement < one grid cell per step)
      var v2 = vX[i] * vX[i] + vY[i] * vY[i];
      if (v2 > maxSpeed * maxSpeed) {
        var f = maxSpeed / Math.sqrt(v2);
        vX[i] *= f; vY[i] *= f;
        v2 = maxSpeed * maxSpeed;
      }

      pX[i] += vX[i] * dt;
      pY[i] += vY[i] * dt;
      pRot[i] += pRotV[i] * dt;
      pRotV[i] *= 0.985;

      // --- lane walls ---------------------------------------------------
      var r = pR[i];
      var e = mRest[sMat[i]];
      if (pX[i] < -lane + r) { pX[i] = -lane + r; if (vX[i] < 0) vX[i] = -vX[i] * e; }
      else if (pX[i] > lane - r) { pX[i] = lane - r; if (vX[i] > 0) vX[i] = -vX[i] * e; }

      // --- vehicle chassis pushes debris aside --------------------------
      if (bodyActive) {
        var bx = pX[i] - bodyX, by = pY[i] - bodyY;
        var ex = bodyHW + r - (bx < 0 ? -bx : bx);
        var ey = bodyHH + r - (by < 0 ? -by : by);
        if (ex > 0 && ey > 0) {
          if (ex < ey) {
            var sx = bx < 0 ? -1 : 1;
            pX[i] += sx * ex;
            vX[i] = sx * Math.max(Math.abs(vX[i]), 140) + bodyVX * 0.25;
          } else {
            var sy = by < 0 ? -1 : 1;
            pY[i] += sy * ey;
            vY[i] = bodyVY + sy * 90;
          }
          sAsleep[i] = 0; pSleep[i] = 0;
        }
      }

      // --- sleep bookkeeping -------------------------------------------
      var s2 = vX[i] * vX[i] + vY[i] * vY[i];
      if (s2 < sleepSpeed2) {
        pSleep[i] += dt;
        if (pSleep[i] >= C.SLEEP_TIME) {
          sAsleep[i] = 1;
          vX[i] = 0; vY[i] = 0; pRotV[i] = 0;
        }
      } else {
        pSleep[i] = 0;
      }
    }
  }

  /* --- 3. relaxation -------------------------------------------------- */
  function relax(dt) {
    var iters = C.RELAX_ITERATIONS;
    var strength = C.CORRECTION_STRENGTH;
    var maxCorr = C.MAX_CORRECTION;
    var wake2 = C.WAKE_SPEED * C.WAKE_SPEED;

    for (var it = 0; it < iters; it++) {
      // Velocity response only on the first pass. Applying restitution on
      // every pass injects energy and makes piles boil.
      var doVel = (it === 0);

      for (var k = 0; k < dynCount; k++) {
        var i = dynList[k];
        if (sState[i] !== LOOSE || sAsleep[i]) continue;

        var xi = pX[i], yi = pY[i], ri = pR[i];
        var wi = pInvM[i];
        var ei = mRest[sMat[i]];

        var baseCol = (xi * INV_CELL + HASH_OFFS) | 0;
        var baseRow = (yi * INV_CELL + HASH_OFFS) | 0;

        for (var dr = -1; dr <= 1; dr++) {
          var rowBase = ((baseRow + dr) & ROWMASK) * COLS;
          for (var dc = -1; dc <= 1; dc++) {
            var j = cellHead[rowBase + ((baseCol + dc) & COLMASK)];
            while (j !== -1) {
              if (j === i) { j = cellNext[j]; continue; }
              var sj = sState[j];
              if (sj === COLLECTED || sj === FREE) { j = cellNext[j]; continue; }

              var dx = pX[j] - xi, dy = pY[j] - yi;
              var rsum = ri + pR[j];
              var d2 = dx * dx + dy * dy;
              if (d2 >= rsum * rsum) { j = cellNext[j]; continue; }

              var d, nx, ny;
              if (d2 < 1e-6) {
                // Perfectly coincident: shove apart in a deterministic-ish way.
                d = 0.001; nx = 0.7071; ny = 0.7071;
              } else {
                d = Math.sqrt(d2); nx = dx / d; ny = dy / d;
              }
              var overlap = rsum - d;
              var corr = overlap * strength;
              if (corr > maxCorr) corr = maxCorr;

              if (sj === SOLID) {
                /* --- loose vs immovable terrain --------------------- */
                xi -= nx * corr; yi -= ny * corr;
                if (doVel) {
                  var vn = vX[i] * nx + vY[i] * ny;
                  if (vn > 0) {
                    var imp = (1 + ei) * vn;
                    vX[i] -= imp * nx;
                    vY[i] -= imp * ny;
                    // tumble on grazing contact
                    pRotV[i] += (vX[i] * ny - vY[i] * nx) * 0.02;
                  }
                }
              } else {
                /* --- loose vs loose --------------------------------- */
                var wj = pInvM[j];
                var wsum = wi + wj;
                if (wsum <= 0) { j = cellNext[j]; continue; }
                var fi = wi / wsum, fj = wj / wsum;
                xi -= nx * corr * fi; yi -= ny * corr * fi;
                pX[j] += nx * corr * fj; pY[j] += ny * corr * fj;

                if (doVel) {
                  var rvn = (vX[j] - vX[i]) * nx + (vY[j] - vY[i]) * ny;
                  if (rvn < 0) {
                    var e2 = ei < mRest[sMat[j]] ? ei : mRest[sMat[j]];
                    var jimp = -(1 + e2) * rvn / wsum;
                    vX[i] -= jimp * wi * nx; vY[i] -= jimp * wi * ny;
                    vX[j] += jimp * wj * nx; vY[j] += jimp * wj * ny;
                  }
                }
                // Wake a sleeping neighbour that just got shoved.
                if (sAsleep[j]) {
                  var si2 = vX[i] * vX[i] + vY[i] * vY[i];
                  if (si2 > wake2 || overlap > pR[j] * 0.35) {
                    sAsleep[j] = 0;
                    pSleep[j] = 0;
                  }
                }
              }
              j = cellNext[j];
            }
          }
        }

        pX[i] = xi;
        pY[i] = yi;
      }
    }
  }

  /* =====================================================================
   * STREAMING SUPPORT
   * ================================================================== */

  /** Recycle everything further "behind" (greater y) than the given line. */
  function despawnBehind(y) {
    for (var k = activeCount - 1; k >= 0; k--) {
      var i = activeList[k];
      if (pY[i] > y) free(i);
    }
  }

  /** Recycle everything further "ahead" (smaller y) than the given line. */
  function despawnAhead(y) {
    for (var k = activeCount - 1; k >= 0; k--) {
      var i = activeList[k];
      if (pY[i] < y) free(i);
    }
  }

  /**
   * Free everything OUTSIDE a rectangle. The second deliberate exception to this
   * file's freeze, and the enabling change for a wide mine.
   *
   * despawnBehind/Ahead cut on a Y line only, which forces a streamer to keep the
   * FULL WIDTH of its world resident and window in one axis. That is why the
   * adventure shaft was capped at 1760 units: widening it multiplied the resident
   * particle count until the slab had to be too short to fill the screen.
   *
   * A rectangle lets a streamer window in BOTH axes, which makes width almost
   * free — the camera only ever sees about 2000 units across, so a much wider
   * mine costs no extra resident particles and no extra draw calls, only a bigger
   * carve mask (one byte per cell, and that lives in a plain typed array).
   *
   * `keepLoose` exists because debris is the player's property: ore tumbling
   * loose or flying to the collector must not evaporate because the chunk it
   * happens to be over got recycled. Pass true to spare LOOSE and COLLECTED and
   * cull only embedded SOLID terrain.
   */
  function despawnOutsideRect(minX, minY, maxX, maxY, keepLoose) {
    for (var k = activeCount - 1; k >= 0; k--) {
      var i = activeList[k];
      if (keepLoose && sState[i] !== SOLID) continue;
      var x = pX[i], y = pY[i];
      if (x < minX || x > maxX || y < minY || y > maxY) free(i);
    }
  }

  /* =====================================================================
   * RENDERING
   * Solids are bucketed per material so we hammer one atlas at a time;
   * loose/collected debris is drawn last so it always reads on top.
   * ================================================================== */
  function render(ctx) {
    var view = SM.camera.getViewBounds();
    var mrg = C.CULL_MARGIN;
    var minX = view.minX - mrg, maxX = view.maxX + mrg;
    var minY = view.minY - mrg, maxY = view.maxY + mrg;
    var lowDetail = SM.camera.getZoom() < C.LOW_DETAIL_ZOOM;

    var i, k, x, y;

    for (k = 0; k < NMAT; k++) matBucketN[k] = 0;
    drawDynN = 0;

    /* --- cull + bucket ------------------------------------------------ */
    for (k = 0; k < activeCount; k++) {
      i = activeList[k];
      x = pX[i]; y = pY[i];
      if (x < minX || x > maxX || y < minY || y > maxY) continue;
      if (sState[i] === SOLID) {
        var m = sMat[i];
        matBucket[m][matBucketN[m]++] = i;
      } else {
        drawDyn[drawDynN++] = i;
      }
    }

    /* --- solids ------------------------------------------------------- */
    if (lowDetail) {
      // Zoomed way out: colour-batched squares. Cheap, still reads as a field.
      for (var mi = 0; mi < NMAT; mi++) {
        var n = matBucketN[mi];
        if (!n) continue;
        var buf = matBucket[mi];
        ctx.fillStyle = MATS()[mi].colors[0];
        for (k = 0; k < n; k++) {
          i = buf[k];
          var r2 = pR[i];
          ctx.fillRect(pX[i] - r2, pY[i] - r2, r2 * 2, r2 * 2);
        }
      }
    } else {
      for (var mj = 0; mj < NMAT; mj++) {
        var cnt = matBucketN[mj];
        if (!cnt) continue;
        var A = atlases[mj];
        var img = A.canvas, cellA = A.cell, halfA = A.half, rowYA = A.rowY;
        var buf2 = matBucket[mj];
        var hardness = mHardness[mj];
        for (k = 0; k < cnt; k++) {
          i = buf2[k];
          var sz = sSize[i];
          // Damaged deposits switch to the brightest shade row — free "cracking"
          // feedback with no extra draw calls.
          var shade = pHp[i] < hardness * 0.55 ? NSHADE - 1 : sShade[i];
          var rotIdx = (pRot[i] * ROT_TO_IDX) & (NROT - 1);
          var cs = cellA[sz], hs = halfA[sz];
          ctx.drawImage(img,
            rotIdx * cs, rowYA[sz * NSHADE + shade], cs, cs,
            pX[i] - hs, pY[i] - hs, cs, cs);
        }
      }
    }

    /* --- loose + collected -------------------------------------------- */
    for (k = 0; k < drawDynN; k++) {
      i = drawDyn[k];
      var mm = sMat[i];
      if (lowDetail) {
        var rr = pR[i];
        ctx.fillStyle = MATS()[mm].colors[2];
        ctx.fillRect(pX[i] - rr, pY[i] - rr, rr * 2, rr * 2);
        continue;
      }
      var B = atlases[mm];
      var szd = sSize[i];
      var cd = B.cell[szd], hd = B.half[szd];
      var ri2 = (pRot[i] * ROT_TO_IDX) & (NROT - 1);
      if (sState[i] === COLLECTED) {
        // Shrink + brighten as it is swallowed by the hopper.
        var t = 1 - Math.min(0.55, pAge[i] * 1.1);
        var w = cd * t;
        ctx.drawImage(B.canvas,
          ri2 * cd, B.rowY[szd * NSHADE + (NSHADE - 1)], cd, cd,
          pX[i] - w * 0.5, pY[i] - w * 0.5, w, w);
      } else {
        ctx.drawImage(B.canvas,
          ri2 * cd, B.rowY[szd * NSHADE + sShade[i]], cd, cd,
          pX[i] - hd, pY[i] - hd, cd, cd);
      }
    }
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    buildMaterialCache();
    buildAtlases();
    reset();
  }

  function reset() {
    freeCount = 0;
    activeCount = 0;
    dynCount = 0;
    looseAlive = 0;
    solidAlive = 0;
    heavyAccum = 0;
    colActive = false;
    bodyActive = false;
    // Fill the pool in descending order so the first allocations come out as
    // 0,1,2,... which keeps memory access mostly sequential early on.
    for (var i = CAP - 1; i >= 0; i--) {
      sState[i] = FREE;
      sAsleep[i] = 0;
      freeStack[freeCount++] = i;
    }
    cellHead.fill(-1);
  }

  /* =====================================================================
   * INTROSPECTION
   * ================================================================== */
  function getStats() {
    statsOut.active = activeCount;
    statsOut.solid = solidAlive;
    statsOut.loose = looseAlive;
    statsOut.collected = dynCount - looseAlive;
    statsOut.free = freeCount;
    return statsOut;
  }

  return {
    // states (exported so other modules can read `data.state`)
    FREE: FREE, SOLID: SOLID, LOOSE: LOOSE, COLLECTED: COLLECTED,

    init: init,
    reset: reset,
    update: update,
    render: render,

    // spawning
    spawnSolid: spawnSolid,
    spawnLoose: spawnLoose,

    // queries / interaction
    queryRect: queryRect,
    damageSolidInRect: damageSolidInRect,
    explode: explode,
    collectInRadius: collectInRadius,
    rebuildGrid: rebuildGrid,

    // vehicle plumbing
    setCollectorTarget: setCollectorTarget,
    clearCollectorTarget: clearCollectorTarget,
    setVehicleBody: setVehicleBody,
    clearVehicleBody: clearVehicleBody,

    // streaming
    despawnBehind: despawnBehind,
    despawnAhead: despawnAhead,
    despawnOutsideRect: despawnOutsideRect,

    // introspection
    getStats: getStats,
    getActiveCount: function () { return activeCount; },
    getLooseCount: function () { return looseAlive; },
    getSolidCount: function () { return solidAlive; },
    getCapacity: function () { return CAP; },

    /**
     * Raw storage. READ-ONLY for other modules — writing here bypasses all the
     * list bookkeeping and will corrupt the pool.
     */
    data: {
      x: pX, y: pY, vx: vX, vy: vY, r: pR, hp: pHp, value: pVal,
      rot: pRot, state: sState, mat: sMat, asleep: sAsleep,
      activeList: activeList,
      get activeCount() { return activeCount; }
    }
  };
})();
