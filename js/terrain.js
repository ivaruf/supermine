/* =============================================================================
 * SUPERMINE — js/terrain.js                        [OWNER: Agent 2 — gameplay]
 * -----------------------------------------------------------------------------
 * Streaming terrain generator. Fills the lane ahead of the vehicle with SOLID
 * material particles in horizontal BANDS and recycles everything that falls
 * far enough behind. The world is NEVER generated all at once.
 *
 * WHAT DECIDES WHAT GOES WHERE
 *   level.js owns the section map. terrain.js asks SM.level.zoneAt(depth) for
 *   the zone covering each row and reads its generation knobs. Everything
 *   below is a function of that zone:
 *
 *   BASE ROCK      dirt / stone / granite mix, plus a LATERAL DENSITY BIAS:
 *                  the right half of the lane is always harder than the left.
 *                  That is the "safe side vs hard side" of every route choice.
 *   ORE POCKETS    ellipses seeded per band. Pockets on the RIGHT roll twice
 *                  and keep the more valuable result -> harder route pays more.
 *   VEINS          long meandering vertical ore lanes. Because generation runs
 *                  ~840 units ahead of the camera these are visible well before
 *                  you reach them, which is what makes the route choice real.
 *   BARRIER SLABS  ('barrier' zones) granite walls across the lane with one or
 *                  two openings you must steer for — or plough through.
 *   CORRIDORS      ('narrow' zones) a wandering open passage with granite walls.
 *   THE CORE       ('final' zone) no dirt at all; the base rock is treasure.
 *
 *   Upgrade gates carve their own opening (read from SM.upgrades.getGates()).
 *
 * Public API
 *   SM.terrain.init() / reset() / update(dt) / render(ctx)
 *   SM.terrain.getGeneratedTo()  most-forward y that has been generated
 *   SM.terrain.setSeed(n)
 * ========================================================================== */

var SM = SM || {};

SM.terrain = (function () {
  'use strict';

  /* ----- Agent-2 tunables local to this file ------------------------- */
  // Deposit spacing. Slightly wider than config's 18 because the upgraded
  // machine makes the camera pull all the way back to the MAX_WALL_VISIBLE
  // floor, which grows the streaming window to ~1600 units tall. At 18 that
  // window plus a full 1200-particle debris torrent runs the 7500 pool dry
  // and streaming stalls; at 19 it leaves ~900 slots of headroom.
  var SPACING = 19.0;
  var DESPAWN_INTERVAL = 6;      // run the recycle sweep every N steps
  var BG_TILE = 128;             // background noise tile size (px)
  var DEBRIS_RESERVE = 700;      // pool slots always kept free for live debris

  // Lateral difficulty gradient: extra probability of hard rock at the far
  // right edge of the lane, tapering to zero at the far left.
  var SIDE_HARD_BIAS = 0.20;

  // --- barrier slabs ('barrier' zones) ---------------------------------
  var BARRIER_PITCH = 480;       // one slab every N units of depth
  var BARRIER_THICK = 240;       // slab thickness along y  (~50% coverage)
  var BARRIER_GAP = 160;         // half-width of the main opening
  var BARRIER_LEAD = 240;        // no slab in the first N units of the zone

  // --- corridors ('narrow' zones) --------------------------------------
  var CORRIDOR_LEAD = 170;
  var CORRIDOR_LIP = 28;         // stone rim between open floor and granite

  var C = SM.config;

  /* ----- streaming state --------------------------------------------- */
  var nextBandY = 0;             // next band's trailing (highest) y
  var pocketY = 0;               // pockets have been seeded down to here
  var deepestY = 0;              // most forward y generated so far
  var despawnTick = 0;

  // Pockets are seeded this far AHEAD of the band being filled, because a
  // large formation can be much taller than one band — if we only seeded per
  // band its trailing half would land in terrain that has already been
  // generated and the deposit would come out sliced off at a band seam.
  var POCKET_LOOKAHEAD = 560;

  /* ----- pockets ------------------------------------------------------ */
  var POCKET_MAX = 96;
  var pkX = new Float32Array(POCKET_MAX);
  var pkY = new Float32Array(POCKET_MAX);
  var pkRX = new Float32Array(POCKET_MAX);
  var pkRY = new Float32Array(POCKET_MAX);
  var pkMat = new Int32Array(POCKET_MAX);   // -1 = void (no spawn)
  var pkCount = 0;

  /* ----- deterministic RNG (mulberry32) ------------------------------- */
  var rngState = 0x9e3779b9;
  function rnd() {
    rngState = (rngState + 0x6D2B79F5) >>> 0;
    var t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function setSeed(n) { rngState = n >>> 0; }

  /** Stateless integer hash — structure placement must not depend on the
   *  order in which bands happen to be generated. */
  function hash1(n) {
    n = n | 0;
    n = (n ^ 61) ^ (n >>> 16);
    n = (n + (n << 3)) | 0;
    n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d);
    n = n ^ (n >>> 15);
    return (n >>> 0) / 4294967296;
  }

  /* ----- cached material indices (resolved on init) -------------------- */
  var M_DIRT = 0, M_STONE = 1, M_RUBBLE = 7, M_GRANITE = 8;

  function resolveMaterials() {
    var mm = SM.materials;
    M_DIRT = mm.indexOf('dirt');
    M_STONE = mm.indexOf('stone');
    M_RUBBLE = mm.indexOf('rubble');
    M_GRANITE = mm.indexOf('granite');
    resolveZones();
  }

  /* =====================================================================
   * ZONE TABLE RESOLUTION
   * level.js declares ore mixes as string ids. Resolve them ONCE into flat
   * typed arrays so the generator never touches a string or an object map.
   * The `$`-prefixed fields are terrain's private cache on level's data.
   * ================================================================== */
  function buildWeighted(pairs) {
    var n = pairs.length;
    var mats = new Int32Array(n);
    var cum = new Float32Array(n);
    var vals = new Float32Array(n);
    var tot = 0;
    for (var i = 0; i < n; i++) {
      mats[i] = SM.materials.indexOf(pairs[i][0]);
      vals[i] = SM.materials.get(mats[i]).value;
      tot += pairs[i][1];
      cum[i] = tot;
    }
    return { mats: mats, cum: cum, vals: vals, total: tot, n: n };
  }

  function pickWeighted(w) {
    var r = rnd() * w.total;
    for (var i = 0; i < w.n; i++) if (r < w.cum[i]) return w.mats[i];
    return w.mats[w.n - 1];
  }

  /** Roll twice and keep the more valuable result (the "hard route" bonus). */
  function pickWeightedRich(w) {
    var a = pickWeighted(w), b = pickWeighted(w);
    return SM.materials.get(a).value >= SM.materials.get(b).value ? a : b;
  }

  function resolveZones() {
    var zones = SM.level.getZones();
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      z.$ores = buildWeighted(z.ores);
      z.$baseOres = z.baseOres ? buildWeighted(z.baseOres) : null;
      z.$vein = SM.materials.indexOf(z.veinOre);
      z.$wall = z.wallMat ? SM.materials.indexOf(z.wallMat) : M_GRANITE;
    }
  }

  /* =====================================================================
   * PER-ROW CONTEXT
   * Structures (barrier slabs, corridors, veins) depend only on y, so they
   * are evaluated ONCE per row and cached in these module-level slots
   * instead of once per deposit. ~70 deposits share every row.
   * ================================================================== */
  var ROW_NONE = 0, ROW_BARRIER = 1, ROW_CORRIDOR = 2;
  var rowKind = ROW_NONE;
  var rowSlabMat = 0;
  var rowGap1 = 0, rowGapW1 = 0, rowGap2 = 0, rowGapW2 = 0, rowHasGap2 = false;
  var rowCorrCx = 0, rowCorrHalf = 0, rowWallMat = 0;
  var rowVeinN = 0;
  var rowVeinCx = new Float32Array(4);
  var rowVeinW = new Float32Array(4);

  function prepareRow(py, depth, z) {
    rowKind = ROW_NONE;
    rowVeinN = 0;

    /* --- barrier slabs ------------------------------------------------ */
    if (z.kind === 'barrier') {
      var local = depth - z.start;
      if (local > BARRIER_LEAD) {
        var idx = (local / BARRIER_PITCH) | 0;
        var phase = local - idx * BARRIER_PITCH;
        if (phase < BARRIER_THICK) {
          rowKind = ROW_BARRIER;
          var lane = C.LANE_HALF_WIDTH;
          var h = hash1(idx * 7919 + z.seed);
          rowGap1 = (h * 2 - 1) * (lane - BARRIER_GAP - 70);
          rowGapW1 = BARRIER_GAP * (0.85 + hash1(idx * 104729 + z.seed) * 0.5);
          rowHasGap2 = hash1(idx * 31337 + z.seed) > 0.62;
          rowGap2 = -rowGap1 * 0.92;
          rowGapW2 = rowGapW1 * 0.45;
          // Softer stone skin on both faces of the slab so it does not read
          // as a solid black bar.
          var edge = phase < BARRIER_THICK - phase ? phase : BARRIER_THICK - phase;
          rowSlabMat = edge < 24 ? M_STONE : z.$wall;
          return;
        }
      }
    }

    /* --- corridors ---------------------------------------------------- */
    if (z.kind === 'narrow') {
      var loc2 = depth - z.start;
      if (loc2 > CORRIDOR_LEAD) {
        rowKind = ROW_CORRIDOR;
        var t = loc2 * 0.0016;
        var ph = z.seed * 0.0007;
        rowCorrCx = Math.sin(t + ph) * z.corridorDrift +
                    Math.sin(t * 2.37 + ph * 1.7) * (z.corridorDrift * 0.32);
        rowCorrHalf = z.corridorHalf + Math.sin(t * 1.7 + 1.2) * z.corridorWave;
        rowWallMat = z.$wall;
        return;
      }
    }

    /* --- ore veins ----------------------------------------------------- */
    if (z.veins > 0) {
      var tv = py * 0.0011;
      var n = z.veins > 4 ? 4 : z.veins;
      for (var v = 0; v < n; v++) {
        var p2 = z.seed * 0.0007 + v * 2.4;
        rowVeinCx[v] = Math.sin(tv + p2) * 300 + Math.sin(tv * 1.9 + p2 * 1.7) * 150;
        rowVeinW[v] = z.veinWidth * (0.75 + 0.35 * Math.sin(tv * 2.6 + p2));
      }
      rowVeinN = n;
    }
  }

  /* =====================================================================
   * MATERIAL SELECTION
   * ================================================================== */

  /** Base rock, with the left-easy / right-hard lateral gradient. */
  function baseMaterial(px, z) {
    if (z.$baseOres) return pickWeighted(z.$baseOres);
    var bias = SIDE_HARD_BIAS * (0.5 + 0.5 * (px / C.LANE_HALF_WIDTH));
    var r = rnd();
    var gw = z.graniteW + bias * 0.35;
    if (r < gw) return M_GRANITE;
    if (r < gw + z.stoneW + bias) return M_STONE;
    return M_DIRT;
  }

  /**
   * Which material belongs at (px, py)?
   * @return material index, or -1 for "leave this spot empty".
   */
  function materialAt(px, py, depth, z) {
    /* --- structural override ------------------------------------------ */
    if (rowKind === ROW_BARRIER) {
      var inGap = (px > rowGap1 - rowGapW1 && px < rowGap1 + rowGapW1) ||
                  (rowHasGap2 && px > rowGap2 - rowGapW2 && px < rowGap2 + rowGapW2);
      if (!inGap) return rowSlabMat;
      return rnd() < 0.74 ? -1 : M_RUBBLE;      // spoil piled in the doorway
    }
    if (rowKind === ROW_CORRIDOR) {
      var d = px - rowCorrCx;
      if (d < 0) d = -d;
      if (d > rowCorrHalf + CORRIDOR_LIP) return rowWallMat;
      if (d > rowCorrHalf) return M_STONE;
      var r0 = rnd();
      if (r0 < 0.60) return -1;                 // the open passage
      if (r0 < 0.60 + z.rubble) return M_RUBBLE;
      return pickWeighted(z.$ores);
    }

    /* --- pockets (newest first so local ones win) ---------------------- */
    for (var i = pkCount - 1; i >= 0; i--) {
      var dx = (px - pkX[i]) / pkRX[i];
      var dy = (py - pkY[i]) / pkRY[i];
      var t = dx * dx + dy * dy;
      if (t <= 1) {
        if (pkMat[i] < 0) {
          // Cavern: mostly hollow, sometimes floored with loose spoil.
          return (z.rubble > 0 && rnd() < z.rubble) ? M_RUBBLE : -1;
        }
        // Soft edge: the rim of a pocket blends back into the surroundings so
        // deposits look eroded rather than stamped.
        if (t > 0.68 && rnd() < (t - 0.68) / 0.32 * 0.7) break;
        return pkMat[i];
      }
    }

    /* --- veins ---------------------------------------------------------- */
    for (var v = 0; v < rowVeinN; v++) {
      var vd = px - rowVeinCx[v];
      if (vd < 0) vd = -vd;
      var vw = rowVeinW[v];
      if (vd < vw) {
        if (vd > vw * 0.72 && rnd() < 0.55) break;   // ragged vein edge
        return z.$vein;
      }
    }

    return baseMaterial(px, z);
  }

  /* =====================================================================
   * POCKETS
   * ================================================================== */
  function pushPocket(x, y, rx, ry, mat) {
    if (pkCount >= POCKET_MAX) prunePockets(y + 700);
    if (pkCount >= POCKET_MAX) pkCount = POCKET_MAX - 1;  // hard safety
    pkX[pkCount] = x; pkY[pkCount] = y;
    pkRX[pkCount] = rx; pkRY[pkCount] = ry;
    pkMat[pkCount] = mat;
    pkCount++;
  }

  /** Drop pockets that are entirely behind the given y (swap-remove). */
  function prunePockets(behindY) {
    for (var i = pkCount - 1; i >= 0; i--) {
      if (pkY[i] - pkRY[i] > behindY) {
        var last = --pkCount;
        pkX[i] = pkX[last]; pkY[i] = pkY[last];
        pkRX[i] = pkRX[last]; pkRY[i] = pkRY[last];
        pkMat[i] = pkMat[last];
      }
    }
  }

  function seedPocketsForBand(y0, y1) {
    var lane = C.LANE_HALF_WIDTH;
    var z = SM.level.zoneAt(C.START_Y - y1);

    // Poisson-ish: guaranteed part plus a fractional chance.
    var n = Math.floor(z.pocketRate);
    if (rnd() < (z.pocketRate - n)) n++;

    for (var k = 0; k < n; k++) {
      var x = (rnd() * 2 - 1) * (lane - 30);
      var y = y1 + rnd() * (y0 - y1);
      var mat, rx, ry;

      if (rnd() < z.voidChance) {
        mat = -1;                                    // cavern
        rx = 30 + rnd() * 62;
        ry = 24 + rnd() * 48;
      } else {
        // Right-hand side of the lane rolls twice and keeps the better ore.
        mat = x > 0 ? pickWeightedRich(z.$ores) : pickWeighted(z.$ores);
        if (rnd() < z.bigChance) {
          rx = 150 + rnd() * 130;                    // huge formation
          ry = rx * (0.5 + rnd() * 0.65);
          if (ry > 300) ry = 300;                    // must fit POCKET_LOOKAHEAD
        } else {
          rx = C.POCKET_MIN_R + rnd() * (C.POCKET_MAX_R - C.POCKET_MIN_R);
          ry = rx * (0.55 + rnd() * 0.85);
        }
      }
      pushPocket(x, y, rx, ry, mat);
    }
  }

  /* =====================================================================
   * BAND GENERATION
   * ================================================================== */

  /* Gates overlapping the current band, prefiltered so the inner loop does
   * not walk the whole gate list ~350 times per band. */
  var GATE_SLOTS = 16;
  var bgX = new Float32Array(GATE_SLOTS);
  var bgHW = new Float32Array(GATE_SLOTS);
  var bgY0 = new Float32Array(GATE_SLOTS);
  var bgY1 = new Float32Array(GATE_SLOTS);
  var bgN = 0;

  function collectBandGates(y0, y1) {
    bgN = 0;
    if (!SM.upgrades || !SM.upgrades.getGates) return;
    var gates = SM.upgrades.getGates();
    var halfCarve = C.GATE_CARVE_DEPTH * 0.5;
    for (var i = 0; i < gates.length && bgN < GATE_SLOTS; i++) {
      var g = gates[i];
      var gy0 = g.y + halfCarve, gy1 = g.y - halfCarve;
      if (gy1 > y0 || gy0 < y1) continue;            // no overlap with the band
      bgX[bgN] = g.x;
      bgHW[bgN] = g.width * 0.5;
      bgY0[bgN] = gy0;
      bgY1[bgN] = gy1;
      bgN++;
    }
  }

  /** Slots one full band needs, plus headroom for in-flight debris. */
  function bandBudget() {
    var rows = C.BAND_HEIGHT / SPACING;
    var cols = (C.LANE_HALF_WIDTH * 2) / SPACING;
    return Math.ceil(rows * cols * 1.1) + DEBRIS_RESERVE;
  }

  /**
   * Fill one band. Returns false if the pool cannot afford it — the caller
   * then stops streaming for this frame rather than producing a half-filled
   * band with visible holes in it.
   */
  function generateBand() {
    if (SM.particles.getStats().free < bandBudget()) return false;

    var y0 = nextBandY;
    var y1 = y0 - C.BAND_HEIGHT;
    // Commit immediately: even if we bail out below we must not re-run this
    // band, or the terrain would be generated twice at double density.
    nextBandY = y1;
    deepestY = y1;

    // Keep the pocket frontier ahead of the fill frontier.
    var pGuard = 32;
    while (pocketY > y1 - POCKET_LOOKAHEAD && pGuard-- > 0) {
      seedPocketsForBand(pocketY, pocketY - C.BAND_HEIGHT);
      pocketY -= C.BAND_HEIGHT;
    }

    collectBandGates(y0, y1);

    var lane = C.LANE_HALF_WIDTH;
    var sp = SPACING;
    var jit = sp * C.TERRAIN_JITTER;
    var startClear2 = C.START_CLEAR_RADIUS * C.START_CLEAR_RADIUS;

    // Row index derived from absolute y so the offset pattern is continuous
    // across band boundaries (no seam every 90 units).
    var rowStart = Math.floor(-y0 / sp);
    var rowEnd = Math.ceil(-y1 / sp);

    for (var row = rowStart; row < rowEnd; row++) {
      var yBase = -row * sp;
      if (yBase > y0 || yBase <= y1) continue;
      var xOffset = (row & 1) ? sp * 0.5 : 0;   // hex-ish stagger
      var depth = C.START_Y - yBase;
      var z = SM.level.zoneAt(depth);
      prepareRow(yBase, depth, z);

      for (var x = -lane + 6 + xOffset; x <= lane - 6; x += sp) {
        var px = x + (rnd() * 2 - 1) * jit;
        var py = yBase + (rnd() * 2 - 1) * jit;

        // --- start pad ------------------------------------------------
        var sdx = px, sdy = py - (C.START_Y + 25);
        if (sdx * sdx + sdy * sdy < startClear2) continue;

        // --- gate / station openings ----------------------------------
        if (bgN) {
          var blocked = false;
          for (var gi = 0; gi < bgN; gi++) {
            if (py < bgY0[gi] && py > bgY1[gi] &&
                px > bgX[gi] - bgHW[gi] && px < bgX[gi] + bgHW[gi]) {
              blocked = true;
              break;
            }
          }
          if (blocked) continue;
        }

        var mat = materialAt(px, py, depth, z);
        if (mat < 0) continue;
        if (SM.particles.spawnSolid(px, py, mat) < 0) return true;  // pool empty
      }
    }
    return true;
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  function init() {
    resolveMaterials();
    buildTiles();
    reset();
  }

  function reset() {
    setSeed(0x9e3779b9);
    pkCount = 0;
    despawnTick = 0;
    nextBandY = C.START_Y + 220;
    pocketY = nextBandY;
    deepestY = nextBandY;
    fillAhead(C.START_Y);
    // The cutter queries the hash on the very first frame, before
    // particles.update() has run — so seed it here.
    SM.particles.rebuildGrid();
  }

  /**
   * How far forward we must have generated: the LARGER of the fixed
   * STREAM_AHEAD budget and whatever the camera can currently see, so that
   * upgrade-driven zoom-outs can never reveal the edge of the world.
   */
  function aheadLimit(vehicleY) {
    var fixed = vehicleY - C.STREAM_AHEAD;
    var v = SM.camera.getViewBounds();
    var visible = v.minY - C.STREAM_VIEW_MARGIN;
    return fixed < visible ? fixed : visible;
  }

  function behindLine(vehicleY) {
    var fixed = vehicleY + C.STREAM_BEHIND;
    var v = SM.camera.getViewBounds();
    var visible = v.maxY + C.STREAM_VIEW_MARGIN;
    return fixed > visible ? fixed : visible;
  }

  function fillAhead(vehicleY) {
    var limit = aheadLimit(vehicleY);
    // Hard cap on bands per call so a huge zoom-out cannot stall a frame.
    var guard = 64;
    while (nextBandY > limit && guard-- > 0) {
      if (!generateBand()) break;                    // pool is full: stop here
    }
  }

  function update(dt) {
    var vy = SM.vehicle.getY();
    fillAhead(vy);

    // Recycling is a full sweep of the active list, so do it periodically
    // rather than every step. STREAM_BEHIND has enough slack to absorb it.
    if (++despawnTick >= DESPAWN_INTERVAL) {
      despawnTick = 0;
      var line = behindLine(vy);
      SM.particles.despawnBehind(line);
      prunePockets(line + 220);
    }
  }

  function getGeneratedTo() { return deepestY; }

  /* =====================================================================
   * BACKGROUND RENDERING
   * Two pre-baked repeating tiles: excavated floor inside the lane, and
   * bedrock outside it. Patterns live in world space so they scroll for free.
   * ================================================================== */
  var floorPattern = null;
  var wallPattern = null;

  function noiseTile(baseR, baseG, baseB, spread, speckle) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = BG_TILE;
    var g = cv.getContext('2d');
    g.fillStyle = 'rgb(' + baseR + ',' + baseG + ',' + baseB + ')';
    g.fillRect(0, 0, BG_TILE, BG_TILE);
    var i, n = speckle;
    for (i = 0; i < n; i++) {
      var f = (rnd() * 2 - 1) * spread;
      var r = Math.max(0, Math.min(255, baseR + f)) | 0;
      var gg = Math.max(0, Math.min(255, baseG + f)) | 0;
      var b = Math.max(0, Math.min(255, baseB + f)) | 0;
      g.fillStyle = 'rgb(' + r + ',' + gg + ',' + b + ')';
      var s = 2 + rnd() * 7;
      g.fillRect(rnd() * BG_TILE, rnd() * BG_TILE, s, s);
    }
    return cv;
  }

  function buildTiles() {
    var saved = rngState;
    setSeed(1234567);
    var floorTile = noiseTile(38, 31, 26, 16, 900);
    // Bedrock is deliberately mid-tone, not near-black: on a wide monitor the
    // walls occupy real screen area and must read as ROCK, not as a void.
    var wallTile = noiseTile(78, 71, 84, 30, 800);
    rngState = saved;

    var probe = document.createElement('canvas').getContext('2d');
    floorPattern = probe.createPattern(floorTile, 'repeat');
    wallPattern = probe.createPattern(wallTile, 'repeat');
  }

  /** Paint one bedrock wall band: noise + horizontal strata + edge shadow. */
  function drawWall(ctx, x0, x1, y0, y1, inwardSign) {
    var w = x1 - x0;
    if (w <= 0) return;

    ctx.fillStyle = wallPattern || '#38333d';
    ctx.fillRect(x0, y0, w, y1 - y0);

    // Strata: long horizontal seams give the rock scale and parallax.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, w, y1 - y0);
    ctx.clip();
    ctx.lineWidth = 2;
    var pitch = 74;
    var first = Math.floor(y0 / pitch) * pitch;
    for (var sy = first; sy < y1; sy += pitch) {
      var jig = ((sy * 0.017) % 1) * 26;
      ctx.strokeStyle = 'rgba(0,0,0,0.34)';
      ctx.beginPath();
      ctx.moveTo(x0 - 10, sy);
      ctx.lineTo(x1 + 10, sy + jig * 0.14);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.beginPath();
      ctx.moveTo(x0 - 10, sy + 3);
      ctx.lineTo(x1 + 10, sy + 3 + jig * 0.14);
      ctx.stroke();
    }
    ctx.restore();

    // Ambient occlusion where the wall meets the excavated lane.
    var edge = inwardSign > 0 ? x0 : x1;
    var g = ctx.createLinearGradient(edge, 0, edge + inwardSign * -58, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x0, y0, w, y1 - y0);
  }

  /** Zone boundary markers: a painted line and the section name on the floor.
   *  Cheap (a handful of strokes) and it makes the level structure legible. */
  function drawZoneMarkers(ctx, v, lane) {
    var zones = SM.level.getZones();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      var wy = C.START_Y - z.start;
      if (wy < v.minY - 80 || wy > v.maxY + 80) continue;

      var hot = z.kind === 'final';
      ctx.strokeStyle = hot ? 'rgba(255,120,220,0.55)' : 'rgba(255,196,64,0.28)';
      ctx.lineWidth = hot ? 6 : 3;
      ctx.beginPath();
      ctx.moveTo(-lane, wy);
      ctx.lineTo(lane, wy);
      ctx.stroke();

      ctx.font = hot
        ? 'bold 40px ui-sans-serif, system-ui, Arial, sans-serif'
        : 'bold 26px ui-sans-serif, system-ui, Arial, sans-serif';
      ctx.fillStyle = hot ? 'rgba(255,150,230,0.30)' : 'rgba(255,220,150,0.16)';
      ctx.fillText(z.name, 0, wy - 30);
    }
  }

  function render(ctx) {
    var v = SM.camera.getViewBounds();
    var lane = C.LANE_HALF_WIDTH;
    var y0 = v.minY - 40, y1 = v.maxY + 40;

    // --- excavated floor ------------------------------------------------
    ctx.fillStyle = floorPattern || '#2a231e';
    ctx.fillRect(v.minX - 40, y0, (v.maxX - v.minX) + 80, y1 - y0);

    // --- bedrock walls left / right -------------------------------------
    if (v.minX < -lane) drawWall(ctx, v.minX - 40, -lane, y0, y1, -1);
    if (v.maxX > lane) drawWall(ctx, lane, v.maxX + 40, y0, y1, 1);

    // --- lane edge trim --------------------------------------------------
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,196,64,0.30)';
    ctx.beginPath();
    ctx.moveTo(-lane, y0); ctx.lineTo(-lane, y1);
    ctx.moveTo(lane, y0); ctx.lineTo(lane, y1);
    ctx.stroke();

    // --- depth ruler every 500 units ------------------------------------
    var step = 500;
    var first = Math.ceil((C.START_Y - v.maxY) / step) * step;
    var last = (C.START_Y - v.minY);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (var d = first; d <= last; d += step) {
      if (d < 0) continue;
      var wy = C.START_Y - d;
      ctx.beginPath();
      ctx.moveTo(-lane, wy); ctx.lineTo(lane, wy);
      ctx.stroke();
      ctx.fillText(d + 'm', lane + 10, wy);
    }

    drawZoneMarkers(ctx, v, lane);
  }

  return {
    init: init,
    reset: reset,
    update: update,
    render: render,
    getGeneratedTo: getGeneratedTo,
    setSeed: setSeed
  };
})();
