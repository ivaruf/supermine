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
 *   POWER-UP BLOCKS a hard-edged disc of time cell / boost cell sitting in an
 *                  excavated chamber of its own. Rare, big and lit against
 *                  black so it reads as "go get that" from across the lane.
 *
 *   Upgrade gates carve their own opening (read from SM.upgrades.getGates()).
 *
 * ADVENTURE MODE                                    [Agent 3, ADVENTURE.md §1]
 *   main.js calls terrain.update() and terrain.render() unconditionally, in
 *   both game modes, so this file is where the two worlds fork. When
 *   SM.advterrain reports a mine is loaded, every entry point below DELEGATES
 *   to it and returns; otherwise it runs exactly the code it ran before, byte
 *   for byte. Nothing classic is behind a new conditional and no classic value
 *   was touched, which is the point: TIME ATTACK and FREESTYLE have to play
 *   identically, and the only way to be sure of that is for the adventure
 *   branch to be a leading `return`.
 *
 *   The fork is feature-detected (`SM.advterrain &&`), so a build without the
 *   adventure modules loads and plays as a pure classic build.
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
  // Deposit spacing. The AUTHORED value is 19 — slightly wider than config's
  // 18 because the upgraded machine makes the camera pull all the way back to
  // the MAX_WALL_VISIBLE floor, which grows the streaming window to ~1600
  // units tall. At 18 that window plus a full 1200-particle debris torrent
  // runs the 7500 pool dry and streaming stalls; at 19 it leaves ~900 slots
  // of headroom.
  //
  // It is no longer a constant. A portrait phone has to show the whole
  // 1280-unit lane across ~390px, which puts ~2940 units of world HEIGHT on
  // screen — two and a half times the area a landscape window streams, and
  // 11 600 deposits against a 7500 pool. camera.js owns that trade (it is the
  // one that decides how much world is on screen), solves the budget once at
  // load and hands us the pitch through getWorldSpacing(); syncDensity()
  // below picks it up. On a landscape desktop the solve lands under 19 and
  // clamps, so nothing there changes at all.
  //
  // The economy follows automatically: camera.js gave materials.js the same
  // number, and every deposit's value and hardness were scaled by the area it
  // now stands for, so a metre of mine is worth the same on every device.
  var SPACING = 19.0;
  var SPACING_AUTHORED = 19.0;   // what the pickup sizes below were tuned at
  var DESPAWN_INTERVAL = 6;      // run the recycle sweep every N steps

  /* DEPOSIT RADIUS vs GRID PITCH.
   * At the authored pitch a deposit is ~9 units in radius against a 19-unit
   * cell, so neighbours touch and overlap and the ground reads as PACKED
   * rock. Widen the cell to 24.5 and leave the radius alone and the same
   * material comes out as gravel scattered on soil — verified on a portrait
   * screenshot, and it is the one genuinely ugly side-effect of the coarser
   * grid.
   *
   * spawnSolid() takes a radius override, so we ask for radii scaled by the
   * pitch: the deposits get chunkier in step with their spacing and the
   * ground closes back up. It cannot close completely — particles.js
   * quantises radius onto its baked sprite buckets and the top bucket is
   * SPRITE_MAX_RADIUS (11), frozen because GRID_CELL is 23 and a diameter
   * over that would break the 3x3 contact scan. So at pitch 24.5 the mean
   * radius lands at ~10.8 instead of the 12.25 that would have deposits
   * actually touching: coverage goes from 73% of the pitch back to 88%,
   * against 95% on desktop. Chunky rather than packed, which is a fair
   * description of what a coarse grid IS.
   *
   * The override deliberately draws from Math.random(), exactly as
   * spawnSolid() does internally when you leave it off, so the generator's
   * own deterministic stream is untouched and a desktop world (gain 1) comes
   * out bit-identical to before this existed. */
  var radMin = null, radSpan = null;   // per material, gain already applied

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

  // --- scattered power-up blocks (time cells / speed boosts) -----------
  // Rate is per generation band, and a band is only BAND_HEIGHT (90) units
  // tall, so this number is small by necessity: 0.045 works out at one block
  // every ~2000 units, roughly every ten seconds at cruising speed. It used to
  // be 0.07 (~1300 units) back when a block was a small cluster of ordinary-
  // looking deposits; now that each one is a five-second event with its own
  // chamber and its own full-screen splash, they have to be spaced far enough
  // apart that seeing one is an occasion. Because they are dropped anywhere
  // across a 1280-wide lane, a good fraction still land off the player's line
  // — which is the whole point. Raising this much past 0.07 turns the clock
  // into a free ride and the run stops being a race.
  // (Rolled per band, and only in bands that are not barrier/narrow — about
  // 70% of the map — so the number you feel while driving is nearer one per
  // 2900 units than one per 2000.)
  var PICKUP_RATE = 0.05;
  var PICKUP_TIME_SHARE = 0.62;  // rest are boosts; time is the scarcer need
  // The disc fills with one DEPOSIT per grid cell (SPACING 19, so one per 361
  // square units), which makes the count pi*r*r/361: at 40 that predicts ~14,
  // and a five-block sample measured 13-18, mean 15.4, at 65-69 units across.
  // FIXED, not a range, on purpose — the splash promises "+5 SEC" and a payout
  // that swung with a rolled radius would make that promise a lie half the
  // time. 80 units across is a bit over half the starting blade width, so it
  // is a real object you aim at rather than something you sweep up in passing.
  //
  // These two are the one place the density compensation could NOT be handled
  // by the material table. A time cell is worth 0 currency; its whole payload
  // is TIME_PER_PIECE seconds per collected FRAGMENT, so what has to be held
  // constant is the fragment count, and that is pi*r*r/SPACING^2. So the
  // radius scales with the pitch (syncDensity below) rather than the value:
  // on a portrait phone the block is ~103 units across instead of 80, made of
  // the same ~15 chunkier deposits, and still pays the +5 SEC it advertises.
  // It is a bigger thing to aim at on the screen that most needs it.
  var PICKUP_RADIUS = 40;
  // The block is carved into an excavated CHAMBER. Two jobs: it makes the
  // glow read against black instead of against dirt, so you spot one from the
  // far side of the lane; and it leaves the shattered cloud nothing to snag
  // on, so a clean hit collects cleanly and the advertised number is honest.
  // Scales with the block so the ratio, and therefore the clearance the cloud
  // gets, is the same everywhere.
  var PICKUP_CHAMBER = 74;

  // The two above, after syncDensity() has scaled them for the live grid.
  var pickupRadius = PICKUP_RADIUS;
  var pickupChamber = PICKUP_CHAMBER;
  // Keep them off the bedrock walls so one can never be unreachable. Measured
  // from the CHAMBER edge, not the block, or a chamber could clip the wall —
  // so it is stated as chamber + clearance and follows the chamber when the
  // grid coarsens.
  var PICKUP_EDGE_CLEAR = 56;    // authored 130 = PICKUP_CHAMBER 74 + 56

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

  /* ----- power-up blocks ----------------------------------------------
   * A SEPARATE list, consulted before the pockets, and this is not tidiness
   * — it is a bug fix. Pockets are walked newest-first, and generateBand()
   * seeds pockets up to POCKET_LOOKAHEAD (560 units, ~6 bands) ahead of the
   * band it is about to fill. So by the time the band holding a block is
   * actually filled, half a dozen NEWER ore formations have been pushed on
   * top of it, and any one of them that overlaps wins. Measured before this
   * list existed: of three blocks the generator seeded over a 16 000-unit
   * run, three were partly or completely eaten and zero reached the player
   * intact. A power-up is a placed object rather than geology, so it stops
   * competing on age and simply outranks everything.
   *
   * Each entry is a block radius inside a chamber radius: inside the block
   * you get the power-up material, between the two you get nothing at all.
   * The empty chamber does two jobs — it makes the glow read against black
   * instead of against dirt, so you spot one from the far side of the lane,
   * and it leaves the shattered cloud nothing to snag on, so a clean hit
   * collects cleanly and the "+5 SEC" the HUD promises is honest.
   * ------------------------------------------------------------------ */
  var BLOCK_MAX = 8;             // live at once; they are ~2000 units apart
  var blX = new Float32Array(BLOCK_MAX);
  var blY = new Float32Array(BLOCK_MAX);
  var blR2 = new Float32Array(BLOCK_MAX);    // squared block radius
  var blC2 = new Float32Array(BLOCK_MAX);    // squared chamber radius
  var blMat = new Int32Array(BLOCK_MAX);
  // 1 once the cutter has reached the block's depth. The presentation layer
  // draws an item over each live block and hides it as the rig closes in; that
  // fade is distance-based, so without a LATCH the item would swell back into
  // view once the machine drove past and the distance grew again — reading as
  // "you missed it" when the player had in fact just eaten it.
  var blSpent = new Uint8Array(BLOCK_MAX);
  var blCount = 0;

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
  var M_TIMECELL = 11, M_BOOSTCELL = 12;   // resolved by id in resolveMaterials()

  function resolveMaterials() {
    var mm = SM.materials;
    M_DIRT = mm.indexOf('dirt');
    M_STONE = mm.indexOf('stone');
    M_RUBBLE = mm.indexOf('rubble');
    M_GRANITE = mm.indexOf('granite');
    M_TIMECELL = mm.indexOf('timecell');
    M_BOOSTCELL = mm.indexOf('boostcell');
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

    /* --- power-up blocks (outrank every pocket; see the list's comment) -- */
    for (var b = 0; b < blCount; b++) {
      var bdx = px - blX[b], bdy = py - blY[b];
      var bd2 = bdx * bdx + bdy * bdy;
      if (bd2 > blC2[b]) continue;              // outside the chamber
      // Hard edge on purpose. Ore pockets get a weathered rim below because
      // they are geology; a manufactured object with a nibbled outline just
      // looks broken, and the clean disc is most of what makes it read as a
      // prize rather than as another lump of glowing rock.
      return bd2 <= blR2[b] ? blMat[b] : -1;
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

  /** Place one power-up block and its chamber. Silently skipped if the list
   *  is full, which can only happen if the rate is raised by an order of
   *  magnitude — dropping one is far better than evicting a live one. */
  function pushBlock(x, y, r, chamber, mat) {
    if (blCount >= BLOCK_MAX) pruneBlocks(y + 700);
    if (blCount >= BLOCK_MAX) return;
    blX[blCount] = x; blY[blCount] = y;
    blR2[blCount] = r * r;
    blC2[blCount] = chamber * chamber;
    blMat[blCount] = mat;
    blSpent[blCount] = 0;
    blCount++;
  }

  /**
   * Latch every block the cutter has now reached. Forward is -y, so the blade
   * front dropping to or below a block's y means the machine has arrived at it.
   * Once set this never clears, which is the whole point: the item graphic must
   * not come back after the rig has driven through it.
   * At most BLOCK_MAX (8) iterations per step.
   */
  function markSpentBlocks() {
    var frontY = SM.vehicle.getBladeFrontY();
    for (var i = 0; i < blCount; i++) {
      if (!blSpent[i] && frontY <= blY[i]) blSpent[i] = 1;
    }
  }

  function pruneBlocks(behindY) {
    for (var i = blCount - 1; i >= 0; i--) {
      if (blY[i] - pickupChamber > behindY) {
        var last = --blCount;
        blX[i] = blX[last]; blY[i] = blY[last];
        blR2[i] = blR2[last]; blC2[i] = blC2[last];
        blMat[i] = blMat[last];
        blSpent[i] = blSpent[last];
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

    seedPickupsForBand(y0, y1, z);
  }

  /** Scatter the occasional time cell / speed boost. */
  function seedPickupsForBand(y0, y1, z) {
    // Barrier slabs and corridor walls are a STRUCTURAL override applied
    // before pockets are ever consulted (see materialAt), so a block seeded
    // inside one would simply never be generated. Skipping those zones costs
    // ~30% of the run's length and avoids silently swallowing power-ups.
    if (z.kind === 'barrier' || z.kind === 'narrow') return;
    if (rnd() >= PICKUP_RATE) return;

    var lane = C.LANE_HALF_WIDTH - (pickupChamber + PICKUP_EDGE_CLEAR);
    var x = (rnd() * 2 - 1) * lane;
    var y = y1 + rnd() * (y0 - y1);
    // A hair of jitter on the block so a row of them down a run does not read
    // as stamped copies; far too small to move the fragment count.
    var r = pickupRadius + (rnd() * 2 - 1) * 2;
    // Always burn the roll, mode or not, so the two modes stay on the same
    // deterministic RNG stream and a freestyle run generates the same terrain
    // as a time run — only the pickup KIND differs.
    var wantTime = rnd() < PICKUP_TIME_SHARE;
    // Freestyle has no clock, so a time cell there is a pickup that pays into
    // nothing. Every block becomes a boost instead.
    if (SM.level.isFreestyle && SM.level.isFreestyle()) wantTime = false;
    pushBlock(x, y, r, pickupChamber, wantTime ? M_TIMECELL : M_BOOSTCELL);
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
        var rad = radMin[mat] + Math.random() * radSpan[mat];
        if (SM.particles.spawnSolid(px, py, mat, rad) < 0) return true;  // pool empty
      }
    }
    return true;
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */
  /**
   * Adopt the grid pitch camera.js solved for this device, and re-derive
   * everything that was sized in grid CELLS rather than world units.
   *
   * Called from init() and reset() rather than every step because the solve
   * is latched for the life of the page — deliberately, since materials.js
   * has already been re-balanced against it and particles.js cannot re-bake
   * its material cache (see solveWorldDensity in camera.js). Calling it on
   * reset() as well costs nothing and means a restart can never inherit a
   * stale pitch if that ever changes.
   *
   * Bands already in the world keep whatever pitch they were generated at.
   * That is safe by construction: generateBand() derives its row indices from
   * absolute y every time, so a pitch change only affects bands generated
   * after it, and the streaming window recycles everything behind the machine
   * within STREAM_BEHIND anyway. Nothing has to be re-generated or patched.
   */
  function syncDensity() {
    var sp = (SM.camera && SM.camera.getWorldSpacing)
      ? SM.camera.getWorldSpacing() : SPACING_AUTHORED;
    if (!(sp > 0)) sp = SPACING_AUTHORED;
    SPACING = sp;
    // Power-up blocks are sized in CELLS, not units — see PICKUP_RADIUS.
    var k = sp / SPACING_AUTHORED;
    pickupRadius = PICKUP_RADIUS * k;
    pickupChamber = PICKUP_CHAMBER * k;

    // Deposits grow with the cell they sit in — see the note by radMin.
    var list = SM.materials.list;
    if (!radMin || radMin.length !== list.length) {
      radMin = new Float32Array(list.length);
      radSpan = new Float32Array(list.length);
    }
    for (var i = 0; i < list.length; i++) {
      radMin[i] = list[i].radius[0] * k;
      radSpan[i] = (list[i].radius[1] - list[i].radius[0]) * k;
    }
  }

  /**
   * A RUN IS LIVE UNDERGROUND. True only between SM.advterrain.beginMine() and
   * endMine(), so classic runs — and any build without the adventure modules at
   * all — never see it. This is the gate on STREAMING.
   */
  function advActive() {
    return !!(SM.advterrain && SM.advterrain.isActive && SM.advterrain.isActive());
  }

  /**
   * ADVENTURE MODE OWNS THE WORLD ON SCREEN. Wider than advActive() by exactly
   * one case: the campaign is still up (extraction card, world map, workshop)
   * but the run has ended, so advterrain has stopped streaming and still has a
   * mine loaded.
   *
   * ADVENTURE.md §2 requires the world to keep RENDERING behind those screens
   * with time stopped. Gating render on advActive() alone meant that on the
   * frame the player was extracted, this file fell straight back to the classic
   * background and painted bedrock lane walls, a classic depth ruler and a
   * "SURFACE CUT" zone banner across the mine, behind the results card. Found
   * on a screenshot; this is the fix.
   *
   * It also makes terrain.reset() a no-op while the campaign is up, which is
   * what stops anything rebuilding the time-attack lane on top of a mine the
   * player is still looking at.
   */
  function advOwns() {
    if (advActive()) return true;
    return !!(SM.adv && SM.adv.isActive && SM.adv.isActive() &&
              SM.advterrain && SM.advterrain.isLoaded && SM.advterrain.isLoaded());
  }

  function init() {
    syncDensity();
    resolveMaterials();
    buildTiles();
    reset();
  }

  function reset() {
    // A restart inside a mine means "re-descend this mine", not "rebuild the
    // time-attack lane underneath the player". main.js already routes its own
    // restart() to SM.adv.restart(), but adv.js may reasonably reset the
    // terrain through the normal entry point, so honour it here too.
    // On a meta screen advterrain.reset() is itself a no-op, which is correct:
    // the mine stays exactly as the player left it, behind the card.
    if (advOwns()) { SM.advterrain.reset(); return; }

    syncDensity();
    setSeed(0x9e3779b9);
    pkCount = 0;
    blCount = 0;
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
    // advOwns(), not advActive(): if a stepped frame ever slips through while a
    // meta screen is up, running the CLASSIC streamer would pour time-attack
    // bands into the pool on top of the mine.
    if (advOwns()) { if (advActive()) SM.advterrain.update(dt); return; }

    var vy = SM.vehicle.getY();
    fillAhead(vy);
    markSpentBlocks();

    // Recycling is a full sweep of the active list, so do it periodically
    // rather than every step. STREAM_BEHIND has enough slack to absorb it.
    if (++despawnTick >= DESPAWN_INTERVAL) {
      despawnTick = 0;
      var line = behindLine(vy);
      SM.particles.despawnBehind(line);
      prunePockets(line + 220);
      pruneBlocks(line + 220);
    }
  }

  function getGeneratedTo() {
    if (advOwns()) return SM.advterrain.getGeneratedTo();
    return deepestY;
  }

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
    if (advOwns()) { SM.advterrain.render(ctx); return; }

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
    setSeed: setSeed,
    /** Live grid pitch. Solved by camera.js; exposed for measurement. */
    getSpacing: function () { return SPACING; },

    /* --- power-up blocks, READ-ONLY -------------------------------------
     * particles.js bakes its sprite atlas from three silhouette families
     * (round / chunk / shard) and is frozen, so a power-up deposit can never
     * look like anything but a rock through the material table alone. The
     * presentation layer therefore draws a real ITEM over each block, and
     * needs to know where they are. Never more than BLOCK_MAX (8) live.
     * Indices are only valid within the current frame — pruneBlocks() does a
     * swap-remove, so nothing outside may hold on to one.
     *
     * ZERO IN ADVENTURE MODE. Power-up blocks are a time-attack device, the
     * adventure streamer never places any, and the list is not cleared when a
     * player leaves a classic run for the campaign — so without this guard
     * effects.js would keep drawing item graphics for blocks that belong to a
     * run that ended, floating in the middle of a mine. */
    getBlockCount: function () { return advOwns() ? 0 : blCount; },
    getBlockX: function (i) { return blX[i]; },
    getBlockY: function (i) { return blY[i]; },
    getBlockRadius: function (i) { return Math.sqrt(blR2[i]); },
    getBlockMaterial: function (i) { return blMat[i]; },
    /** false once the cutter has reached it — stop drawing its item. */
    isBlockLive: function (i) { return blSpent[i] === 0; }
  };
})();
