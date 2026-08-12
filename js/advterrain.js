/* =============================================================================
 * SUPERMINE — js/advterrain.js                       [OWNER: Agent 3 — GEOLOGY]
 * -----------------------------------------------------------------------------
 * THE UNDERGROUND. Generates one mine from its seed and its layer table, streams
 * it around the machine, and remembers every hole the player has ever dug in it.
 *
 * ---------------------------------------------------------------------------
 * THE THREE HARD CONSTRAINTS, AND HOW THIS FILE ANSWERS THEM
 *
 * 1. GENERATION IS POSITIONALLY DETERMINISTIC.
 *    Adventure mode lets the player drive back UP, so a band streams out and
 *    streams in again and what comes back has to be identical. There is
 *    therefore NO RNG STREAM IN THIS FILE — not one call to Math.random() on
 *    any path that decides what a cell contains. Every decision is a pure
 *    function of (mineSeed, cellX, cellY) routed through h3()/hv(), and every
 *    structure — seam, pocket, cavern, old drift, motherlode — is derived from
 *    the hash of its own STRUCTURE-CELL INDEX, so it exists at the same place
 *    with the same shape whether you meet it going down or coming back up.
 *
 *    The invariants that make that true, in order of how easy they are to
 *    break by accident:
 *      * The generation grid is anchored to the MINE, not to the machine:
 *        cell (cx, cy) is always the same patch of rock. See cellXOf/cellYOf.
 *      * Jitter is hashed, not rolled. A deposit's offset inside its cell is
 *        hv(S_JX/S_JY, cx, cy), so it lands in the same spot every time — and
 *        because |jitter| < SP/2 the position ROUND-TRIPS: floor() recovers the
 *        exact cell it came from, which is what lets the carve mask key off a
 *        destroyed particle's world position.
 *      * prepareRow() gathers structures from a candidate set derived only from
 *        the row's y, in a fixed order. Nothing carries over between rows.
 *      * Anything cosmetic and per-particle (sprite rotation, shade) is
 *        particles.js's own Math.random() and is deliberately NOT part of the
 *        contract. Material identity is; which of three shade rows it drew is
 *        not.
 *
 * 2. THE CARVE MASK IS WHAT MAKES TUNNELS REAL.
 *    One byte per generation cell for the whole mine (cols x rows, 247 x 260 =
 *    63 KB for the shallowest mine in the catalogue and 247 x 1745 = 421 KB for
 *    the deepest). ONE FLAT TYPED ARRAY, deliberately, rather than a sparse map
 *    of allocated blocks: this is the hottest path in the file
 *    (`material:destroyed` fires up to ~150 times per step) and a flat array
 *    makes it two integer divides and one byte write with no hashing, no
 *    allocation and no branch on "has this block been created yet". 421 KB for
 *    the one mine that is resident at a time is a price worth paying for that,
 *    and it is also what keeps the save seam (exportMask/importMask, a plain
 *    length check) as simple as it is.
 *    `material:destroyed` marks the cell it came from — O(1), allocation-free,
 *    no strings — and generation
 *    skips marked cells. Without it, driving back through your own tunnel
 *    re-fills it with solid rock. js/save.js RLE-encodes the array between
 *    sessions; the seam is exportMask() / importMask() and it round-trips
 *    byte-for-byte.
 *
 * 3. THE POOL IS 7500 AND THE WINDOW IS A 2D RECTANGLE OF CELLS.
 *    The mine is 5200 world units across — far more than any screen shows and
 *    far more than the pool could hold — so the resident set is a RECTANGLE in
 *    BOTH axes, sized from the camera's view plus ADV.STREAM_MARGIN and clamped
 *    by SOLID_BUDGET. Everything outside it is freed with
 *    particles.despawnOutsideRect(). Three things make that safe:
 *
 *      * THE CUTS LAND ON EXACT CELL BOUNDARIES. A row boundary was always
 *        clean (|jitterY| < SP/2). A COLUMN boundary is only clean if the
 *        stagger and the x-jitter together stay inside half a cell, which is
 *        why STAGGER + JITTER_X < 0.5 is an invariant of this file and why the
 *        two jitters are separate constants. Cutting anywhere else would leave
 *        part of a strip alive and the refill would regenerate it on top of its
 *        own survivors, at double density.
 *      * ALL FOUR EDGES ARE TRIMMED. Players drive back up AND sideways.
 *      * THE LIVE EXTENT NEVER REACHES THE SPATIAL HASH'S WRAP. particles.js
 *        indexes a 128 x 256 grid of 23-unit cells with a bitmask, so it tiles
 *        every 2944 units in x and 5888 in y; two world cells that far apart
 *        alias to the same hash cell and collision detection silently
 *        corrupts. WIN_MAX_W / WIN_MAX_H (2800 x 5600) bound the window, and
 *        the KEEP rect that bounds loose debris (see trimTo) is clamped to the
 *        same box, so nothing live is ever 2944 units from anything else live.
 *
 *    Streaming refuses to run a strip when the pool is tight, so the graceful
 *    failure is "streaming pauses", never "pool exhausted", and the window
 *    self-trims (see `trim`) if resident solids ever cross the budget.
 *
 * ---------------------------------------------------------------------------
 * THE GEOLOGY, IN THE ORDER THE GENERATOR ASKS THE QUESTIONS
 *
 *   MOUTH CHAMBER   an excavated portal at the top so the machine is not born
 *                   buried, and so EXIT_RADIUS is reachable.
 *   BEDROCK FLOOR   below the mine's stated depth. The bottom of a mine is
 *                   expressed as HARDNESS (26), not as an invisible wall.
 *   MOTHERLODE      the money shot. A big natural cavern whose far WALL is
 *                   lined with a thick shell of the deepest ore in the mine.
 *                   Every mine has exactly one guaranteed one, plus a hashed
 *                   chance of more in its deep layers. The approach is
 *                   readable: HALO STRINGERS of the same ore thicken in the
 *                   country rock as you close in, the background carries a
 *                   faint bloom of its colour through the rock, and the
 *                   scanner sees it long before the drill does.
 *   CAVERNS         open voids with spoil on the floor, sometimes mineralised.
 *                   Somewhere for the eye to go, and free metres of travel.
 *   OLD WORKINGS    abandoned timbered drifts and winzes. They reward exploring
 *                   SIDEWAYS: an open drift costs no drilling and almost no
 *                   fuel, so finding one is finding a road.
 *   POCKETS         ore lenses. Blobs, with eroded rims, never lone blocks.
 *   SEAMS           ore beds that follow the strata, pinching and swelling
 *                   along their length the way a real seam does.
 *   STRATA          the country rock, in BEDS. A layer is not one material, it
 *                   is two or three interbedded ones on a warped pitch, and
 *                   the background render draws the same warped boundaries the
 *                   generator used — so a wall genuinely reads as strata.
 *
 * WHAT js/mines.js HAS TO SUPPLY, AND WHAT IS OPTIONAL
 *   Required (documented in mines.js): toDepth, name, fill, weights,
 *   pocketRate, cavernRate, hardnessScale, heat. `pocketRate` and `cavernRate`
 *   are per GENERATED BAND as mines.js states them, and perCell() converts.
 *   Optional extras this generator understands, all with sensible depth-derived
 *   defaults so a layer table that only has the required fields still produces
 *   a full arc from soft rich topsoil to barren deep rock with motherlodes in
 *   it:  beds:['sandstone','limestone']  bedPitch  seamRate  driftRate
 *        lodeRate  lode:'ancient'  vugChance
 *
 * NOTE ON hardnessScale: particles.js bakes a deposit's hp from the MATERIAL
 * TABLE at spawn and `SM.particles.data` is read-only, so a per-layer hardness
 * multiplier cannot be applied to the particle. It is honoured the only way it
 * honestly can be — by biasing bed selection toward the harder rock in the
 * layer (see buildBeds) — and it is also exposed verbatim on layerAtY() so
 * js/vehicle.js can factor it into drill progress if Agent 1 wants it.
 *
 * EVENTS EMITTED
 *   mine:layer  {name, depthM}            crossing into a new layer
 *   mine:lode   {x, y, matIndex, dist}    first approach to a motherlode
 *   Both payloads are REUSED objects. Read what you need inside the handler.
 * ========================================================================== */

var SM = SM || {};

SM.advterrain = (function () {
  'use strict';

  /* ======================================================================
   * ----- Agent-3 tunables -----
   * =================================================================== */

  var A = SM.config.ADV;
  var C = SM.config;

  /* --- the generation grid ------------------------------------------- */
  // SP and the shaft width are SM.config.ADV's (shared, frozen). Everything
  // below is derived from them so nothing has to be re-tuned if they move.
  var SP = A.SPACING;                 // 21 — cell pitch, also the mask pitch
  var HALF_W = A.MINE_HALF_WIDTH;     // 880

  /* JITTER — how far a deposit may wander inside its own cell, as a fraction
   * of SP. Both axes MUST stay < 0.5 or a deposit crosses into the neighbouring
   * cell and markDestroyed() carves the wrong hole.
   *
   * THE X BUDGET IS SHARED WITH THE STAGGER, AND THAT IS WHAT MAKES A COLUMN
   * BOUNDARY A LEGAL DESPAWN CUT. A deposit of column cx sits at
   *     x0 + (cx + 0.5)*SP  +- STAGGER*SP  +- JITTER_X*SP
   * so it stays strictly inside the pure column slab [x0+cx*SP, x0+(cx+1)*SP]
   * exactly while STAGGER + JITTER_X < 0.5. At 0.24 + 0.22 = 0.46 there are
   * 0.04*SP (0.84 units) of clearance on each side of every column boundary,
   * which is what lets trimTo() cut on colEdgeX() and know it took ALL of one
   * column and NONE of the next. Y has no stagger, so it keeps the full 0.30.
   * Raise either of these and the 2D window starts double-generating the
   * strips at its own edges. */
  var JITTER = 0.30;   // y jitter (no stagger to share the budget with)
  var JITTER_X = 0.22; // x jitter; STAGGER + JITTER_X must stay < 0.5
  var STAGGER = 0.24;  // rows alternate +-this*SP laterally: a hex-ish packing
                       // that stops the field reading as graph paper. Kept
                       // symmetric (not the classic 0/+0.5) so neither wall
                       // gets a repeating gap on alternate rows.
  var RAD_GAIN = SP / 19.0;   // deposits grow with the coarser adventure pitch
                              // so the ground still closes up. particles.js
                              // clamps to SPRITE_MAX_RADIUS (11) for us.

  /* --- the streamed window -------------------------------------------- */
  var DEBRIS_RESERVE = 700;    // pool slots always kept free for live debris
  var FILL_ESTIMATE = 0.99;    // fraction of cells that produce a deposit.
                               // MEASURED, per layer, over the whole shipped
                               // catalogue: 0.79 in the barren deep floors,
                               // 0.89 where caverns and drifts punch holes,
                               // and 0.96-0.98 in solid granite and obsidian.
                               // The number that matters is the WORST case, so
                               // this is near 1: erring high only costs slab
                               // height, which the headlight hides, while
                               // erring low overshoots SOLID_BUDGET and makes
                               // the adaptive trim do work it should not have
                               // to. At 0.94 the peak measured 5275 against a
                               // 5200 budget; at 0.99 it stays under.
  var BUDGET_EASE = 0.99;      // start trimming at this fraction of the budget.
                               // generateStrip() is the HARD cap and cannot be
                               // crossed; this is only there to stop the window
                               // sitting against that cap and losing a strip at
                               // one edge every few steps, so it wants to be
                               // close to 1 — trimming early just throws away
                               // window nobody asked for.
  var WINDOW_MIN_HALF = 380;   // never stream a window smaller than this, on
                               // either axis, whatever the budget says
  var WINDOW_BIAS = 0.45;      // how far off centre the camera may drag the
                               // window, as a fraction of its half-extent, per
                               // axis. The machine can therefore never leave
                               // its own terrain.

  /* THE HASH-ALIAS CEILING. particles.js wraps its spatial hash every
   * GRID_COLS*GRID_CELL = 2944 units in x and GRID_ROWS*GRID_CELL = 5888 in y.
   * Two live particles that far apart share a hash cell and collide with each
   * other at a distance. These bound the KEEP rect (trimTo), which is the
   * outermost thing that can hold a live particle, so they are the real
   * guarantee — not just a window size. 5% of margin under the wrap. */
  var WIN_MAX_W = 2800;
  var WIN_MAX_H = 5600;

  /* Loose debris — and dumped-cargo heaps, which ARE loose particles — is spared
   * inside this much slack around the solid window, and freed outside it. Ore
   * you are standing next to is your property; ore a screen away has been
   * abandoned, and the pile system already knows how to bring an abandoned heap
   * back (releasePilesOutside -> plUp = 0 -> spawnReadyPiles). Freeing it is
   * also what stops one dumped heap 4000 units away from aliasing into the
   * machine's own hash cells. */
  var LOOSE_KEEP_PAD = 360;

  var CELLS_PER_STEP = 560;    // generation budget per step while playing. One
                               // edge strip is ~60-90 cells, so this is 6-9
                               // strips = 126-190 world units of edge advance
                               // per step against a machine that moves ~4.
  var DESPAWN_INTERVAL = 5;    // sweep the active list every N steps
  var TRIM_MIN = 0.55;         // hard floor on the adaptive window shrink
  var TRIM_DOWN = 0.02;        // per-step shrink while over budget
  var TRIM_UP = 0.004;         // per-step recovery once back under

  /* --- the mine mouth ------------------------------------------------- */
  var MOUTH_R = 250;           // excavated portal chamber radius
  var MOUTH_CY = 70;           // its centre, world units below MINE_CEILING_Y
  var SKY_DEPTH = 300;         // world units of daylight ramp above the mouth
  var FLOOR_PAD_M = 60;        // metres of bedrock modelled below the bottom

  /* --- structure grids -----------------------------------------------
   * Every structure family owns a grid of cells; a cell either contains one
   * structure or does not, decided by one hash of its integer index. That is
   * the whole determinism story: no seeding order, no lookahead, no pruning.
   * ------------------------------------------------------------------ */
  var BAND_REF = C.BAND_HEIGHT;      // 90 — the "band" mines.js states rates in

  var POCKET_W = 300, POCKET_H = 240;
  var POCKET_MIN_R = 46, POCKET_MAX_R = 128;
  var POCKET_BIG = 0.16;             // chance a pocket is a big lens instead
  var POCKET_BIG_R = 210;

  var CAVERN_W = 620, CAVERN_H = 520;
  var CAVERN_MIN_R = 105, CAVERN_MAX_R = 235;
  var CAVERN_MINERAL = 0.30;         // chance a cavern's wall carries ore
  var CAVERN_SHELL = [1.14, 1.34];   // squared-t range of a mineralised shell
  var RUBBLE_FLOOR = 0.42;           // spoil density on a cavern floor

  /* MOTHERLODES AND OLD WORKINGS ARE ON A 2D GRID, NOT A LADDER.
   * Both used to own one candidate per vertical block, placed anywhere across
   * the shaft — which was right when the shaft was 1760 wide, i.e. about one
   * candidate wide. In a 5200-unit mine that same ladder puts a third as many
   * formations in the same volume of rock and the mode's two best discoveries
   * become three times rarer per metre driven. So both grids now have an X
   * pitch, sized at the ORIGINAL shaft width: at HALF_W 880 there is exactly
   * one candidate column and the shipped feel is unchanged, and a wider mine
   * gets proportionally more of them. This is the same areal-density-invariance
   * perCell() already gives pockets and caverns. */
  var LODE_W = 1760;                 // one motherlode slot per 176 m across
  var LODE_H = 1500;                 // ...and per 150 m of depth
  var LODE_RX = [190, 330];
  var LODE_RY = [140, 250];
  var LODE_SHELL = [1.40, 1.72];     // the glittering wall, as squared-t
  var HALO_T = 3.4;                  // stringers reach this far out (in t)
  var HALO_MAX = 0.22;               // stringer density at the shell wall
  var LODE_ANNOUNCE = 760;           // world units at which `mine:lode` fires
  // The ANCIENT FORMATION is the reward for the bottom of a deep mine, and the
  // brief asks for it in "the deepest mine". A layer table may name it outright
  // (`lode:'ancient'`), but js/mines.js states only the fields its own header
  // documents, so the deepest layer of any mine at least this deep gets it by
  // default. Below that the motherlode is the best ore the layer already has,
  // which keeps a shallow mine's headline formation in proportion to the mine.
  var ANCIENT_DEPTH_M = 650;
  /* The GUARANTEED motherlode stays within this of the shaft centre. The mouth
   * is at x = 0 and depth is still the axis of progression, so "go all the way
   * down and there is one waiting" has to survive the mine getting three times
   * wider: a headline formation 2400 units off to one side is not a reward, it
   * is a lottery. Rolled lodes are free to be anywhere. */
  var LODE_GUARANTEED_X = 1150;

  var DRIFT_W = 1760;                // one old-workings slot per 176 m across
  var DRIFT_H = 780;                 // ...and per 78 m of depth
  var DRIFT_MIN_W = 420, DRIFT_MAX_W = 1500;
  var DRIFT_WINZE = 0.45;            // chance a drift also sinks a winze
  var DRIFT_TIMBER_PITCH = 96;       // spacing of timber sets, for render()

  var SEAM_PITCH = 168;              // one candidate ore bed per 16.8 m
  var SEAM_WARP = 34;                // how far a seam's centre line wanders
  var SEAM_WARP_F = 0.0026;          // ...and how quickly, per world unit
  var SEAM_LENS_F = 0.0034;          // pinch-and-swell frequency along x

  var BED_PITCH = 58;                // country-rock bed thickness (base)
  var BED_WARP = 30;                 // how far a bed boundary undulates
  var BED_WARP_F = 0.0021;
  var BED_SPECK = 0.055;             // nodules of a different bed inside a bed

  /* --- hash salts ----------------------------------------------------
   * Odd 32-bit constants. Every independent decision gets its own salt so two
   * unrelated questions asked about the same cell can never correlate.
   * ------------------------------------------------------------------ */
  var S_JX = 0x1f83d9ab | 0, S_JY = 0x5be0cd19 | 0;
  var S_BED = 0x428a2f98 | 0, S_BEDM = 0x71374491 | 0, S_SPECK = 0xb5c0fbcf | 0;
  var S_POCK = 0xe9b5dba5 | 0, S_POCKM = 0x3956c25b | 0, S_RIM = 0x59f111f1 | 0;
  var S_CAV = 0x923f82a4 | 0, S_CAVM = 0xab1c5ed5 | 0;
  var S_LODE = 0xd807aa98 | 0, S_LODEM = 0x12835b01 | 0;
  var S_DRIFT = 0x243185be | 0, S_SEAM = 0x550c7dc3 | 0, S_SEAMM = 0x72be5d74 | 0;
  var S_HALO = 0x80deb1fe | 0, S_FLOOR = 0x9bdc06a7 | 0;

  /* ================================================================== */

  /* ----- module state ------------------------------------------------
   * TWO FLAGS, NOT ONE, and the difference was a bug found in testing.
   *
   *   active  a run is live: generate, stream, and mark the carve mask.
   *   loaded  a mine's geology is RESOLVED and can still be drawn.
   *
   * endMine() clears `active` and keeps `loaded`, because adventure mode keeps
   * rendering the world behind its meta screens (ADVENTURE.md §2: "the world
   * still renders behind the map; time does not pass"). With one flag, the
   * frame the player was extracted on, terrain.js fell back to its CLASSIC
   * background — bedrock lane walls, classic depth ruler and a "SURFACE CUT"
   * zone banner painted across the mine, behind the extraction card. `loaded`
   * is what keeps the mine on screen until the campaign itself is closed.
   * ------------------------------------------------------------------ */
  var active = false;
  var loaded = false;
  var mineDef = null;             // the SM.mines record, or null (default profile)
  var mineStateRef = null;        // the save record's per-mine object, or null
  var mineSeed = 1337 | 0;
  var mineDepthM = 400;
  var floorY = 4000;              // bedrock starts here
  var layers = [];
  var deepestY = 0;

  /* ----- the generation grid, resolved once per mine ------------------ */
  var cols = 1, rows = 1;
  var x0 = -HALF_W, y0 = 0;       // world position of cell (0,0)'s top-left
  var mask = null;                // Uint8Array(cols*rows) — 1 = dug out
  var carved = 0;                 // how many cells are marked

  /* ----- the streamed window -------------------------------------------
   * TWO RECTANGLES IN CELL SPACE, and the difference between them is the whole
   * streaming state machine:
   *   have*   what is GENERATED right now. Always a full rectangle: every grow
   *           step fills one complete edge strip across the other axis's current
   *           extent, so "resident" never means "resident with holes in it".
   *   want*   what the camera would like, from computeWindow().
   * The fill loop walks have -> want one strip at a time, nearest edge first;
   * the sweep trims have back to want. Because both are integer CELL rectangles
   * every despawn cut lands on an exact cell boundary — see the header.
   * ------------------------------------------------------------------ */
  var haveN = false;              // is there a resident rectangle at all?
  var haveC0 = 0, haveC1 = 0;     // resident columns, [C0, C1)
  var haveR0 = 0, haveR1 = 0;     // resident rows, [R0, R1)
  var wantC0 = 0, wantC1 = 0, wantR0 = 0, wantR1 = 0;
  var winL = 0, winR = 0, winTop = 0, winBot = 0;   // the window in world units
  var cellBudget = 5200;          // cells the pool can afford, before trim
  var trim = 1;                   // adaptive shrink, 1 = full budget
  var sweepTick = 0;
  var peakSolid = 0, lowFree = 1e9;
  var peakWinW = 0, peakWinH = 0; // measured window extent, for the hash audit
  var peakLiveW = 0, peakLiveH = 0;

  /* ----- focus override (diagnostics / scripted tests) ---------------- */
  var focusOn = false, focusFX = 0, focusFY = 0;

  /* ----- cached material indices -------------------------------------- */
  var M_DIRT = 0, M_STONE = 1, M_RUBBLE = 7, M_GRANITE = 8, M_BEDROCK = 0;

  /* ----- reused event payloads ---------------------------------------- */
  var evLayer = { name: '', depthM: 0 };
  var evLode = { x: 0, y: 0, matIndex: 0, dist: 0 };

  /* ======================================================================
   * HASHING — the entire source of randomness in this file
   * =================================================================== */

  /**
   * Stateless 32-bit hash of three integers. Math.imul throughout: the naive
   * `a * 374761393` overflows the 53-bit float mantissa for any a past 2^24
   * and quietly stops being a hash.
   */
  function h3(a, b, c) {
    var n = Math.imul(a | 0, 0x27d4eb2d) ^
            Math.imul(b | 0, 0x165667b1) ^
            Math.imul(c | 0, 0x9e3779b1);
    n = Math.imul(n ^ (n >>> 15), 0x85ebca6b);
    n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
    return (n ^ (n >>> 16)) >>> 0;
  }

  /** Hash -> 0..1, salted and tied to the mine seed. */
  function hv(salt, a, b) { return h3(mineSeed ^ salt, a, b) / 4294967296; }

  /** Smooth 1D value noise, 0..1. Used for every warp and every taper. */
  function noise1(t, salt) {
    var i0 = Math.floor(t);
    var f = t - i0;
    var a = hv(salt, i0, 0), b = hv(salt, i0 + 1, 0);
    var s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  }
  /** Same, mapped to -1..1. */
  function noise1s(t, salt) { return noise1(t, salt) * 2 - 1; }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ======================================================================
   * CELL <-> WORLD
   * The grid is anchored to the MINE. Cell (0,0)'s top-left corner is
   * (x0, MINE_CEILING_Y), and cols is chosen so the grid is centred in the
   * shaft with a sliver of clearance against each bedrock wall.
   * =================================================================== */

  function buildGrid() {
    cols = Math.floor((HALF_W * 2) / SP);
    if (cols < 4) cols = 4;
    x0 = -HALF_W + ((HALF_W * 2) - cols * SP) * 0.5;
    y0 = A.MINE_CEILING_Y;
    var bottomM = mineDepthM + FLOOR_PAD_M;
    rows = Math.ceil((bottomM / A.METERS_PER_UNIT) / SP) + 2;
    if (rows < 8) rows = 8;
    // How many CELLS the pool can hold, which is what a 2D window is sized
    // against. Cells, not deposits: FILL_ESTIMATE is the conversion.
    cellBudget = A.SOLID_BUDGET / FILL_ESTIMATE;
  }

  /** Lateral offset of row `cy` — the alternating hex-ish stagger. */
  function rowStagger(cy) { return (cy & 1) ? SP * STAGGER : -SP * STAGGER; }

  /** World y of the TOP edge of row cy. The despawn lines snap to these. */
  function rowTopY(cy) { return y0 + cy * SP; }
  /** World y of the centre of row cy, before jitter. */
  function rowMidY(cy) { return y0 + (cy + 0.5) * SP; }

  /** Row containing world y. */
  function cellYOf(y) { return Math.floor((y - y0) / SP); }
  /** Column containing world x, on row cy. */
  function cellXOf(x, cy) { return Math.floor((x - rowStagger(cy) - x0) / SP); }

  /* THE TWO X MAPPINGS, AND WHY THERE ARE TWO.
   *
   * cellXOf(x, cy) answers "which cell did this DEPOSIT come from", so it has
   * to undo the row's stagger — that is what makes markDestroyed() carve the
   * hole the player actually drilled.
   *
   * colEdgeX(cx) / colOfX(x) answer "where is the boundary between column cx-1
   * and column cx", which must be the SAME LINE on every row or a despawn cut
   * could not separate two columns cleanly on all of them at once. That line is
   * the un-staggered lattice, and STAGGER + JITTER_X < 0.5 is precisely the
   * condition that every deposit of column cx lies strictly between
   * colEdgeX(cx) and colEdgeX(cx + 1) whatever its row parity. */
  function colEdgeX(cx) { return x0 + cx * SP; }
  function colOfX(x) { return Math.floor((x - x0) / SP); }

  /* ======================================================================
   * THE CARVE MASK
   * =================================================================== */

  function allocMask() {
    var n = cols * rows;
    if (!mask || mask.length !== n) mask = new Uint8Array(n);
    else mask.fill(0);
    carved = 0;
  }

  /**
   * Mark the cell containing (x, y) as dug out.
   *
   * HOT PATH: `material:destroyed` fires up to ~150 times per step. Integer
   * maths and one array write, no allocation, no strings, no events.
   */
  function markDestroyed(x, y) {
    if (!active || !mask) return;
    var cy = Math.floor((y - y0) / SP);
    if (cy < 0 || cy >= rows) return;         // above the mouth / below the pad
    var cx = Math.floor((x - ((cy & 1) ? SP * STAGGER : -SP * STAGGER) - x0) / SP);
    if (cx < 0 || cx >= cols) return;
    var i = cy * cols + cx;
    if (mask[i]) return;
    mask[i] = 1;
    carved++;
  }

  function isCarved(x, y) {
    if (!mask) return false;
    var cy = cellYOf(y);
    if (cy < 0 || cy >= rows) return false;
    var cx = cellXOf(x, cy);
    if (cx < 0 || cx >= cols) return false;
    return mask[cy * cols + cx] === 1;
  }

  function exportMask() { return mask; }

  /** Adopt a decoded mask. Refuses anything that is not exactly our shape. */
  function importMask(u8) {
    if (!mask || !u8 || !u8.length || u8.length !== mask.length) return false;
    mask.set(u8);
    carved = 0;
    for (var i = 0; i < mask.length; i++) if (mask[i]) carved++;
    return true;
  }

  var dimsOut = { cols: 0, rows: 0, spacing: 0, x0: 0, y0: 0, length: 0 };
  /**
   * Keyed on the ARRAY existing, not on a run being live: js/save.js validates
   * a decoded mask's length against this, and it does that around load and save
   * — both of which can happen with no run in progress.
   */
  function maskDims() {
    if (!mask) return null;
    dimsOut.cols = cols; dimsOut.rows = rows; dimsOut.spacing = SP;
    dimsOut.x0 = x0; dimsOut.y0 = y0;
    dimsOut.length = cols * rows;
    return dimsOut;
  }

  /* ======================================================================
   * MATERIALS AND LAYER TABLES
   * =================================================================== */

  /* The ids this generator places. js/mines.js prices and sizes cargo against
   * exactly these strings, so they are listed once, here, and nowhere else. */
  var MAT_IDS = [
    'clay', 'coal', 'copper', 'sandstone', 'limestone',
    'silver', 'platinum', 'uranium', 'ancient', 'bedrock'
  ];

  function resolveMaterials() {
    var mm = SM.materials;
    M_DIRT = mm.indexOf('dirt');
    M_STONE = mm.indexOf('stone');
    M_RUBBLE = mm.indexOf('rubble');
    M_GRANITE = mm.indexOf('granite');
    M_BEDROCK = mm.indexOf('bedrock');
  }

  function matIdx(id, fallback) {
    var m = id ? SM.materials.getById(id) : null;
    if (m) return m.index;
    if (fallback) {
      var f = SM.materials.getById(fallback);
      if (f) return f.index;
    }
    return M_STONE;
  }

  function num(v, dflt) { return (typeof v === 'number' && isFinite(v)) ? v : dflt; }

  /**
   * THE DEFAULT PROFILE. Used whenever SM.mines has nothing to say — during the
   * parallel build (its stub returns null), for a mine whose record has no
   * layer table, and as the shape of the arc every authored mine should follow:
   *
   *   soft, cheap and generous at the top  ->  hard, barren and enormous at the
   *   bottom. The last layer's pocketRate is a fifth of the first's and its ore
   *   lottery is nearly worthless, which is exactly what makes breaking into an
   *   'ancient' lode down there land the way it should.
   */
  var DEFAULT_LAYERS = [
    { toDepth: 30, name: 'TOPSOIL', fill: 'dirt', beds: ['dirt', 'clay'],
      weights: { coal: 6, copper: 1 },
      pocketRate: 0.95, cavernRate: 0.05, seamRate: 0.40, driftRate: 0.40,
      hardnessScale: 1.0, heat: 0 },
    { toDepth: 90, name: 'CLAY BEDS', fill: 'clay', beds: ['clay', 'sandstone', 'dirt'],
      weights: { coal: 8, copper: 3, iron: 2 },
      pocketRate: 0.85, cavernRate: 0.09, seamRate: 0.42, driftRate: 0.36,
      hardnessScale: 1.0, heat: 0 },
    { toDepth: 180, name: 'SANDSTONE', fill: 'sandstone',
      beds: ['sandstone', 'limestone', 'clay'],
      weights: { copper: 6, iron: 4, coal: 3, silver: 1 },
      pocketRate: 0.70, cavernRate: 0.12, seamRate: 0.32, driftRate: 0.26,
      hardnessScale: 1.05, heat: 0.05 },
    { toDepth: 300, name: 'LIMESTONE', fill: 'limestone',
      beds: ['limestone', 'sandstone', 'stone'],
      weights: { silver: 5, copper: 3, gold: 2 },
      pocketRate: 0.55, cavernRate: 0.20, seamRate: 0.24, driftRate: 0.16,
      lodeRate: 0.14, hardnessScale: 1.15, heat: 0.15 },
    { toDepth: 460, name: 'GRANITE', fill: 'granite', beds: ['granite', 'stone'],
      weights: { gold: 5, platinum: 2, uranium: 2, silver: 2 },
      pocketRate: 0.32, cavernRate: 0.11, seamRate: 0.14, driftRate: 0.07,
      lodeRate: 0.26, hardnessScale: 1.3, heat: 0.35 },
    { toDepth: 1e9, name: 'THE DEEP', fill: 'obsidian',
      beds: ['obsidian', 'granite', 'bedrock'],
      weights: { platinum: 4, uranium: 4, gold: 2 },
      pocketRate: 0.18, cavernRate: 0.08, seamRate: 0.06, driftRate: 0.02,
      lodeRate: 0.42, lode: 'ancient', hardnessScale: 1.5, heat: 0.7 }
  ];

  /** {a:6, b:2} -> flat weighted table. Unknown ids resolve to stone. */
  function buildWeights(obj) {
    var keys = [], k;
    if (obj) for (k in obj) if (obj.hasOwnProperty(k) && obj[k] > 0) keys.push(k);
    if (!keys.length) return null;
    var w = { n: keys.length, mats: new Int32Array(keys.length),
              cum: new Float32Array(keys.length), tot: 0 };
    for (var i = 0; i < keys.length; i++) {
      w.mats[i] = matIdx(keys[i], 'stone');
      w.tot += obj[keys[i]];
      w.cum[i] = w.tot;
    }
    return w;
  }

  function pickWeighted(w, u) {
    if (!w) return M_STONE;
    var r = u * w.tot;
    for (var i = 0; i < w.n; i++) if (r < w.cum[i]) return w.mats[i];
    return w.mats[w.n - 1];
  }

  function richestOre(w) {
    if (!w) return M_STONE;
    var best = w.mats[0], bv = -1;
    for (var i = 0; i < w.n; i++) {
      var v = SM.materials.get(w.mats[i]).baseValue;
      if (v > bv) { bv = v; best = w.mats[i]; }
    }
    return best;
  }

  /**
   * The COUNTRY ROCK of a layer, as a weighted table of two or three beds.
   * The declared `fill` always dominates; the accents are what make a bed
   * boundary visible. `hardnessScale` is spent here (see the header note):
   * above 1 it re-weights the table toward the harder beds, which is the only
   * lever on toughness this module actually owns.
   */
  function buildBeds(src, L) {
    var ids = (src.beds && src.beds.length) ? src.beds : null;
    var obj = {};
    if (ids) {
      // First entry is the dominant bed; the rest share the remainder.
      for (var i = 0; i < ids.length; i++) obj[ids[i]] = (i === 0) ? 6 : 2;
    } else {
      obj[src.fill || 'stone'] = 6;
      // No beds authored: pair the fill with a plausible partner so the layer
      // still has strata instead of being one flat colour.
      var partner = BED_PARTNER[src.fill] || 'stone';
      if (partner !== src.fill) obj[partner] = 2;
    }
    var w = buildWeights(obj);
    if (!w) return null;
    // Re-weight by hardness if the layer asked to be tougher than its rock.
    var hs = num(src.hardnessScale, 1);
    if (hs > 1.01 && w.n > 1) {
      var tot = 0, raw = new Float32Array(w.n), prev = 0;
      for (var j = 0; j < w.n; j++) {
        var base = w.cum[j] - prev; prev = w.cum[j];
        var hard = SM.materials.get(w.mats[j]).baseHardness + 0.5;
        raw[j] = base * Math.pow(hard, (hs - 1) * 1.6);
        tot += raw[j];
        w.cum[j] = tot;
      }
      w.tot = tot;
    }
    return w;
  }

  /** Plausible interbed partners, so an un-authored layer still has strata. */
  var BED_PARTNER = {
    dirt: 'clay', clay: 'sandstone', sandstone: 'limestone',
    limestone: 'sandstone', stone: 'limestone', granite: 'stone',
    obsidian: 'granite', bedrock: 'obsidian'
  };

  /**
   * mines.js states pocketRate and cavernRate as "expected per generated
   * band", where a band is BAND_REF tall and the full shaft wide. Convert to a
   * probability per structure cell of the given size.
   */
  function perCell(rate, cw, ch, dflt) {
    var r = num(rate, dflt);
    if (!(r > 0)) return 0;
    var cellsPerBand = ((HALF_W * 2) / cw) * (BAND_REF / ch);
    if (!(cellsPerBand > 0)) return 0;
    var p = r / cellsPerBand;
    return p > 0.85 ? 0.85 : p;
  }

  function buildLayers(def) {
    layers.length = 0;
    var src = (def && def.layers && def.layers.length) ? def.layers : DEFAULT_LAYERS;
    var n = src.length;
    for (var i = 0; i < n; i++) {
      var s = src[i] || {};
      // Relative depth of this layer, 0 = shallowest .. 1 = deepest. Every
      // optional rate defaults off this, which is what gives an under-specified
      // layer table the arc described in the header for free.
      var f = (n <= 1) ? 1 : i / (n - 1);
      var L = {};
      L.idx = i;
      L.name = s.name || ('LAYER ' + (i + 1));
      L.toDepth = num(s.toDepth, 1e9);
      L.toY = yOfDepth(L.toDepth);
      L.fill = matIdx(s.fill, 'stone');
      L.beds = buildBeds(s, L);
      L.ores = buildWeights(s.weights);
      L.pocketP = perCell(s.pocketRate, POCKET_W, POCKET_H, 0.9 - 0.7 * f);
      L.cavernP = perCell(s.cavernRate, CAVERN_W, CAVERN_H, 0.06 + 0.10 * f);
      L.seamP = num(s.seamRate, 0.38 - 0.26 * f);
      L.driftP = num(s.driftRate, 0.42 - 0.36 * f);
      L.lodeP = num(s.lodeRate, f < 0.55 ? 0 : (f - 0.55) / 0.45 * 0.42);
      L.lodeMat = s.lode ? matIdx(s.lode, 'ancient')
        : ((i === n - 1 && mineDepthM >= ANCIENT_DEPTH_M)
            ? matIdx('ancient', 'starcore')
            : richestOre(L.ores));
      L.bedPitch = num(s.bedPitch, BED_PITCH * (0.78 + hv(S_BED, i, 5) * 0.55));
      L.hardnessScale = num(s.hardnessScale, 1);
      L.heat = num(s.heat, 0);
      L.vug = num(s.vugChance, 0.16 - 0.10 * f);
      layers.push(L);
    }
    // The deepest layer always runs to the bottom of the world, whatever it
    // declared: below it there is only bedrock, and that is floorY's job.
    layers[layers.length - 1].toY = 1e12;
  }

  function layerIndexAtY(y) {
    for (var i = 0; i < layers.length; i++) if (y < layers[i].toY) return i;
    return layers.length - 1;
  }
  function layerAtY(y) {
    if (!layers.length) return null;
    return layers[layerIndexAtY(y)];
  }

  /* ======================================================================
   * PER-ROW STRUCTURE CONTEXT
   *
   * Structures are gathered ONCE per row and cached in these flat arrays, then
   * ~83 deposits share the result — the same trick classic terrain.js uses in
   * prepareRow(), for the same reason. A blob's index in the list is stable
   * within a row, and every hash keyed off a blob uses the blob's own id (a
   * hash of its structure-cell index) rather than that list index, so nothing
   * here depends on gather ORDER for anything but priority.
   *
   * PRIORITY is the list order: motherlodes are pushed first, then caverns,
   * then pockets, and cellMaterialAt() returns on the first hit. Old workings
   * are checked between caverns and pockets — an old drift through an ore
   * pocket means the ore was taken out a century ago, which is the truth we
   * want, and it also stops a drift being blocked by geology it predates.
   * =================================================================== */
  var K_LODE = 0, K_CAVERN = 1, K_POCKET = 2;

  // Sized for the widest strip a 2D window generates (a full window-wide row),
  // with headroom: a 5200-unit mine's shallow layers can put a dozen pockets
  // and a couple of caverns across one row, and a dropped blob would be a
  // formation the scanner reports and the rock does not contain.
  var BLOB_MAX = 64;
  var bbX = new Float32Array(BLOB_MAX);
  var bbY = new Float32Array(BLOB_MAX);
  var bbRX = new Float32Array(BLOB_MAX);
  var bbRY = new Float32Array(BLOB_MAX);
  var bbMat = new Int32Array(BLOB_MAX);     // shell/lens material, -1 = plain void
  var bbShell = new Float32Array(BLOB_MAX); // squared-t out to which it acts
  var bbKind = new Uint8Array(BLOB_MAX);
  var bbId = new Int32Array(BLOB_MAX);      // stable per-structure hash
  var bbN = 0;

  var HALO_MAXN = 16;
  var hlX = new Float32Array(HALO_MAXN);
  var hlY = new Float32Array(HALO_MAXN);
  var hlRX = new Float32Array(HALO_MAXN);
  var hlRY = new Float32Array(HALO_MAXN);
  var hlMat = new Int32Array(HALO_MAXN);
  var hlN = 0;

  var DRIFT_MAXN = 24;      // drifts AND winzes take a slot; a wide mine has
                            // several old workings side by side on one row
  var drX0 = new Float32Array(DRIFT_MAXN);
  var drX1 = new Float32Array(DRIFT_MAXN);
  var drY0 = new Float32Array(DRIFT_MAXN);
  var drY1 = new Float32Array(DRIFT_MAXN);
  var drId = new Int32Array(DRIFT_MAXN);
  var drN = 0;

  var seamOn = false, seamJ = 0, seamCy = 0, seamHalf = 0,
      seamMat = 0, seamPinch = 0.4;

  /* THE STRIP'S X SPAN, and why every gather is filtered against it.
   *
   * The lists above are capped, and a cap that can be REACHED would break
   * positional determinism: which structures got dropped would depend on how
   * wide the strip being filled happened to be, so the same cell could resolve
   * differently when refilled from the side instead of from above.
   *
   * Two things together make that impossible. Every push is filtered by x
   * overlap with the strip, so the list only ever holds structures that can
   * actually touch the cells being filled — a handful, not a mine's worth. And
   * the caps are then set far above that handful. (Everything a wide gather
   * admits and a narrow one does not is geometrically rejected per cell anyway,
   * and both iterate in the same ascending grid order, so a non-saturated list
   * gives byte-identical results either way. That is the whole argument.)
   * ------------------------------------------------------------------ */
  var gxA = 0, gxB = 0;

  function pushBlob(x, y, rx, ry, m, shell, kind, id) {
    if (bbN >= BLOB_MAX) return;
    var reach = rx * Math.sqrt(shell);
    if (x + reach < gxA || x - reach > gxB) return;
    bbX[bbN] = x; bbY[bbN] = y; bbRX[bbN] = rx; bbRY[bbN] = ry;
    bbMat[bbN] = m; bbShell[bbN] = shell; bbKind[bbN] = kind; bbId[bbN] = id;
    bbN++;
  }

  /* ----- motherlodes -------------------------------------------------
   * THE MONEY SHOT. A big cavern with a thick ore shell lining its wall, so
   * the moment of breaking through reads as "the wall collapses into a huge
   * natural cavern, and across the cavern wall is an enormous glittering
   * mineral vein" and not as "a bigger ore pocket".
   *
   * Every mine gets exactly ONE guaranteed lode, placed deterministically in
   * the lowest 20-140 m of its stated depth — the reward for going all the way
   * down is never a coin flip. Deep layers then roll for extra ones on the
   * LODE_H grid, so a big mine can hold several and a shallow one holds only
   * the guaranteed one.
   * ------------------------------------------------------------------ */

  /** Fill the lode scratch slots for grid cell (i, j). -> true if one exists. */
  var lodeX = 0, lodeY = 0, lodeRX = 0, lodeRY = 0, lodeMat = 0, lodeShell = 0, lodeId = 0;

  function lodeOfCell(i, j) {
    var yc = (j + 0.5) * LODE_H + (hv(S_LODE, i * 71 + 1, j) - 0.5) * LODE_H * 0.7;
    var L = layerAtY(yc);
    if (!L || L.lodeP <= 0) return false;
    if (hv(S_LODE, i * 71 + 2, j) >= L.lodeP) return false;
    return describeLode(i, j, yc, L, 1.0, false);
  }

  /**
   * Resolve one motherlode into the scratch slots.
   * `centred` is the guaranteed lode: it is placed near the shaft centre rather
   * than anywhere across the width (see LODE_GUARANTEED_X), because it is the
   * payoff for DEPTH and the mouth is at x = 0.
   */
  function describeLode(i, j, yc, L, scale, centred) {
    if (!L) return false;
    lodeId = h3(mineSeed ^ S_LODE, i * 71 + 7, j) | 0;
    lodeRX = lerp(LODE_RX[0], LODE_RX[1], hv(S_LODE, i * 71 + 3, j)) * scale;
    lodeRY = lerp(LODE_RY[0], LODE_RY[1], hv(S_LODE, i * 71 + 4, j)) * scale;
    // Keep the whole chamber inside the shaft, shell included.
    var inset = lodeRX * Math.sqrt(LODE_SHELL[1]) + 30;
    var u = hv(S_LODE, i * 71 + 5, j);
    if (centred) {
      var span = HALF_W - inset;
      if (span > LODE_GUARANTEED_X) span = LODE_GUARANTEED_X;
      if (span < 0) span = 0;
      lodeX = (u * 2 - 1) * span;
    } else {
      /* Anchored to the lode grid cell, then pulled inside the walls. The
       * REJECT comes first and matters: the i-range a caller scans is padded by
       * the halo reach, so without it every cell beyond the wall would resolve
       * to a lode clamped ONTO the wall and a wide mine would grow a stack of
       * them along both edges. A cell whose anchor is outside the mine has no
       * lode; a cell whose anchor is inside keeps it, hugging the wall if it
       * must. */
      lodeX = (i + u) * LODE_W;
      if (lodeX < -HALF_W || lodeX > HALF_W) return false;
      var lim = HALF_W - inset;
      if (lim < 0) lim = 0;
      if (lodeX > lim) lodeX = lim; else if (lodeX < -lim) lodeX = -lim;
    }
    lodeY = yc;
    lodeShell = lerp(LODE_SHELL[0], LODE_SHELL[1], hv(S_LODE, i * 71 + 6, j));
    lodeMat = L.lodeMat;
    return true;
  }

  /* Structure-grid cell range covering [xLo, xHi] with `pad` units of reach.
   * Every 2D structure family resolves its i-range through these two so the
   * generator, the scanner and the renderer can never disagree about which
   * cells they are looking at. */
  function cellI0(xLo, w, pad) { return Math.floor((xLo - pad) / w); }
  function cellI1(xHi, w, pad) { return Math.floor((xHi + pad) / w); }

  /** The guaranteed motherlode of this mine. Cached; depends only on the seed. */
  var gldValid = false, gldX = 0, gldY = 0, gldRX = 0, gldRY = 0,
      gldMat = 0, gldShell = 0, gldId = 0;

  function buildGuaranteedLode() {
    gldValid = false;
    if (!layers.length) return;
    var bottom = yOfDepth(mineDepthM);
    var up = 200 + hv(S_LODE, 991, 1) * 1200;      // 20-140 m above the floor
    var yc = bottom - up;
    if (yc < yOfDepth(20)) yc = yOfDepth(20);
    var L = layerAtY(yc);
    // A little bigger than a rolled one: this is the mine's headline formation.
    if (!describeLode(0, 991, yc, L, 1.18, true)) return;
    gldValid = true;
    gldX = lodeX; gldY = lodeY; gldRX = lodeRX; gldRY = lodeRY;
    gldMat = lodeMat; gldShell = lodeShell; gldId = lodeId;
  }

  /**
   * Gather the lodes whose shell or halo can reach the strip being generated.
   * [gxLo, gxHi] is that strip's world x span: a 2D window generates one narrow
   * edge strip at a time, so restricting the structure scan to it is both the
   * correct answer and what keeps a wide mine's generator cheap.
   */
  function gatherLodes(ry, gxLo, gxHi) {
    hlN = 0;
    var reach = LODE_RX[1] * HALO_T;               // widest halo we can be in
    var j0 = Math.floor((ry - reach) / LODE_H);
    var j1 = Math.floor((ry + reach) / LODE_H);
    var i0 = cellI0(gxLo, LODE_W, reach + LODE_W);
    var i1 = cellI1(gxHi, LODE_W, reach + LODE_W);
    var i, j;
    for (j = j0; j <= j1; j++) {
      for (i = i0; i <= i1; i++) {
        if (!lodeOfCell(i, j)) continue;
        considerLode(ry, lodeX, lodeY, lodeRX, lodeRY, lodeMat, lodeShell, lodeId);
      }
    }
    if (gldValid) {
      considerLode(ry, gldX, gldY, gldRX, gldRY, gldMat, gldShell, gldId);
    }
  }

  function considerLode(ry, lx, ly, rx, ryd, m, shell, id) {
    var sh = Math.sqrt(shell);
    var dy = ry - ly; if (dy < 0) dy = -dy;
    if (dy <= ryd * sh + SP) {
      pushBlob(lx, ly, rx, ryd, m, shell, K_LODE, id);
    }
    // The halo reaches further than the shell — that is the whole point of it.
    if (dy <= ryd * sh * HALO_T && hlN < HALO_MAXN &&
        lx + rx * sh * HALO_T >= gxA && lx - rx * sh * HALO_T <= gxB) {
      hlX[hlN] = lx; hlY[hlN] = ly;
      hlRX[hlN] = rx * sh; hlRY[hlN] = ryd * sh;
      hlMat[hlN] = m;
      hlN++;
    }
  }

  /* ----- caverns ------------------------------------------------------
   * A STRUCTURE BELONGS TO THE LAYER ITS CENTRE IS IN, not to the layer of the
   * row we happen to be filling. That is not a detail: probeAll() (the
   * scanner) asks about structures without any row context at all, so if the
   * two disagreed the scanner would report formations that do not exist, and
   * miss ones that do, everywhere near a layer boundary. Both paths resolve the
   * layer the same way — from the structure's own hashed centre.
   * ------------------------------------------------------------------ */
  function gatherCaverns(ry, gxLo, gxHi) {
    var i0 = cellI0(gxLo, CAVERN_W, CAVERN_MAX_R + CAVERN_W);
    var i1 = cellI1(gxHi, CAVERN_W, CAVERN_MAX_R + CAVERN_W);
    var j0 = Math.floor((ry - CAVERN_MAX_R - SP) / CAVERN_H);
    var j1 = Math.floor((ry + CAVERN_MAX_R + SP) / CAVERN_H);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var cyw = j * CAVERN_H + hv(S_CAV, i * 31 + 4, j) * CAVERN_H;
        var L = layerAtY(cyw);
        if (!L || L.cavernP <= 0) continue;
        if (hv(S_CAV, i, j) >= L.cavernP) continue;
        var rx = lerp(CAVERN_MIN_R, CAVERN_MAX_R, hv(S_CAV, i * 31 + 1, j));
        var ryd = rx * lerp(0.44, 0.86, hv(S_CAV, i * 31 + 2, j));
        var cxw = i * CAVERN_W + hv(S_CAV, i * 31 + 3, j) * CAVERN_W;
        var mineral = hv(S_CAVM, i, j) < CAVERN_MINERAL;
        var shell = mineral
          ? lerp(CAVERN_SHELL[0], CAVERN_SHELL[1], hv(S_CAVM, i + 7, j))
          : 1;
        var dy = ry - cyw; if (dy < 0) dy = -dy;
        if (dy > ryd * Math.sqrt(shell) + SP) continue;
        var m = mineral && L.ores ? pickWeighted(L.ores, hv(S_CAVM, i + 13, j)) : -1;
        pushBlob(cxw, cyw, rx, ryd, m, shell, K_CAVERN, h3(mineSeed ^ S_CAV, i, j) | 0);
      }
    }
  }

  /* ----- ore pockets -------------------------------------------------- */
  function gatherPockets(ry, gxLo, gxHi) {
    var i0 = cellI0(gxLo, POCKET_W, POCKET_BIG_R + POCKET_W);
    var i1 = cellI1(gxHi, POCKET_W, POCKET_BIG_R + POCKET_W);
    var j0 = Math.floor((ry - POCKET_BIG_R - SP) / POCKET_H);
    var j1 = Math.floor((ry + POCKET_BIG_R + SP) / POCKET_H);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var cyw = j * POCKET_H + hv(S_POCK, i * 17 + 5, j) * POCKET_H;
        var L = layerAtY(cyw);
        if (!L || L.pocketP <= 0) continue;
        if (hv(S_POCK, i, j) >= L.pocketP) continue;
        var big = hv(S_POCK, i * 17 + 1, j) < POCKET_BIG;
        var rx = big
          ? lerp(POCKET_MAX_R, POCKET_BIG_R, hv(S_POCK, i * 17 + 2, j))
          : lerp(POCKET_MIN_R, POCKET_MAX_R, hv(S_POCK, i * 17 + 2, j));
        var ryd = rx * lerp(0.48, 0.95, hv(S_POCK, i * 17 + 3, j));
        var cxw = i * POCKET_W + hv(S_POCK, i * 17 + 4, j) * POCKET_W;
        var dy = ry - cyw; if (dy < 0) dy = -dy;
        if (dy > ryd + SP) continue;
        // A minority of pockets are VUGS — hollow, not ore. They are what stops
        // "a blob in the wall" from always meaning "money", so breaking into
        // one is a real (small) disappointment rather than a free reward.
        var vug = hv(S_POCKM, i, j) < L.vug;
        var m = vug ? -1 : pickWeighted(L.ores, hv(S_POCKM, i + 5, j));
        pushBlob(cxw, cyw, rx, ryd, m, 1, K_POCKET, h3(mineSeed ^ S_POCK, i, j) | 0);
      }
    }
  }

  /* ----- old workings -------------------------------------------------
   * An abandoned drift is a horizontal void with a hashed span, optionally
   * with a winze (a vertical shaft) sunk from one end. Mechanically it is a
   * ROAD: no drilling, almost no fuel, and it runs sideways, which is the only
   * reason a player would ever leave the straight line down. render() draws
   * timber sets in them so they read as somebody else's mine, not as a crack.
   * ------------------------------------------------------------------ */
  /**
   * Resolve the drift of grid cell (i, j) into the scratch slots below.
   * ONE resolver, called by the generator AND by drawTimbers(), because the two
   * agreeing is not optional: timbers painted where there is no void read as
   * timbers embedded in solid rock, and a bare drift reads as a crack.
   */
  var dfX = 0, dfY = 0, dfW = 0, dfH = 0, dfId = 0;

  function driftOfCell(i, j) {
    var yc = j * DRIFT_H + hv(S_DRIFT, i * 53 + 2, j) * DRIFT_H;
    var L = layerAtY(yc);
    if (!L || L.driftP <= 0) return false;
    if (hv(S_DRIFT, i * 53 + 1, j) >= L.driftP) return false;
    var w = lerp(DRIFT_MIN_W, DRIFT_MAX_W, hv(S_DRIFT, i * 53 + 4, j));
    // Anchored to the cell, rejected if the cell is not in this mine, then
    // pulled inside the walls — see the note in describeLode().
    var cx = (i + hv(S_DRIFT, i * 53 + 5, j)) * DRIFT_W;
    if (cx < -HALF_W || cx > HALF_W) return false;
    var lim = HALF_W - w * 0.5 - 20;
    if (lim < 0) lim = 0;
    if (cx > lim) cx = lim; else if (cx < -lim) cx = -lim;
    dfX = cx; dfY = yc; dfW = w;
    dfH = SP * lerp(1.7, 3.1, hv(S_DRIFT, i * 53 + 3, j));
    dfId = h3(mineSeed ^ S_DRIFT, i * 53 + 9, j) | 0;
    return true;
  }

  function gatherDrifts(ry, gxLo, gxHi) {
    drN = 0;
    var j0 = Math.floor((ry - DRIFT_H) / DRIFT_H);
    var j1 = Math.floor((ry + DRIFT_H) / DRIFT_H);
    var i0 = cellI0(gxLo, DRIFT_W, DRIFT_MAX_W + DRIFT_W);
    var i1 = cellI1(gxHi, DRIFT_W, DRIFT_MAX_W + DRIFT_W);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        if (!driftOfCell(i, j)) continue;
        var yc = dfY, h = dfH, w = dfW, cxw = dfX, id = dfId;
        // See gxA. The pad covers the winze, which straddles one END of the
        // drift and so reaches a little past its x span.
        var xr = w * 0.5 + SP * 2;
        if (cxw + xr < gxA || cxw - xr > gxB) continue;
        if (ry > yc - h * 0.5 - SP && ry < yc + h * 0.5 + SP && drN < DRIFT_MAXN) {
          drX0[drN] = cxw - w * 0.5; drX1[drN] = cxw + w * 0.5;
          drY0[drN] = yc - h * 0.5; drY1[drN] = yc + h * 0.5;
          drId[drN] = id;
          drN++;
        }
        // The winze: sunk from one end of the drift, down towards the next one.
        if (hv(S_DRIFT, i * 53 + 6, j) < DRIFT_WINZE && drN < DRIFT_MAXN) {
          var wx = (hv(S_DRIFT, i * 53 + 7, j) < 0.5) ? cxw - w * 0.5 : cxw + w * 0.5;
          var ww = SP * lerp(2.0, 3.4, hv(S_DRIFT, i * 53 + 8, j));
          var wy1 = yc + lerp(160, DRIFT_H * 0.85, hv(S_DRIFT, i * 53 + 9, j));
          if (ry > yc - SP && ry < wy1 + SP) {
            drX0[drN] = wx - ww * 0.5; drX1[drN] = wx + ww * 0.5;
            drY0[drN] = yc; drY1[drN] = wy1;
            drId[drN] = id ^ 0x5f5f5f5f;
            drN++;
          }
        }
      }
    }
  }

  /* ----- ore seams ---------------------------------------------------
   * A seam follows the strata: a thin bed of ore on the SEAM_PITCH ladder,
   * with a centre line that wanders and a thickness that pinches out to
   * nothing and swells again along its length. That lenticular shape is most
   * of what separates "a seam" from "a horizontal stripe".
   * ------------------------------------------------------------------ */
  function prepareSeam(ry) {
    seamOn = false;
    var si = Math.floor(ry / SEAM_PITCH);
    for (var k = -1; k <= 1; k++) {
      var j = si + k;
      var cyc = (j + 0.18 + hv(S_SEAM, j, 101) * 0.64) * SEAM_PITCH;
      var L = layerAtY(cyc);
      if (!L || L.seamP <= 0 || !L.ores) continue;
      if (hv(S_SEAM, j, L.idx) >= L.seamP) continue;
      var half = SP * lerp(0.7, 2.3, hv(S_SEAM, j, 202));
      if (ry < cyc - half - SEAM_WARP - SP) continue;
      if (ry > cyc + half + SEAM_WARP + SP) continue;
      seamOn = true;
      seamJ = j;
      seamCy = cyc;
      seamHalf = half;
      seamMat = pickWeighted(L.ores, hv(S_SEAMM, j, L.idx));
      seamPinch = lerp(0.30, 0.64, hv(S_SEAM, j, 303));
      return;
    }
  }

  /**
   * Gather the structures that can touch row `cy` between world x `gxLo` and
   * `gxHi`. The x range is the STRIP being filled, not the mine: a column strip
   * asks about 21 units of rock and a row strip about the width of the window,
   * and the cost of the gather tracks that instead of the mine's width.
   */
  function prepareRow(cy, ry, L, gxLo, gxHi) {
    bbN = 0;
    gxA = gxLo; gxB = gxHi;
    gatherLodes(ry, gxLo, gxHi);
    gatherCaverns(ry, gxLo, gxHi);
    gatherPockets(ry, gxLo, gxHi);
    gatherDrifts(ry, gxLo, gxHi);
    prepareSeam(ry);
  }

  /* ======================================================================
   * WHAT IS AT THIS CELL?
   * -> material index, or -1 for "leave this spot empty".
   * A pure function of (mineSeed, cx, cy) and the row context prepared above.
   * =================================================================== */
  function cellMaterialAt(cx, cy, px, py, L) {
    var i, dx, dy, t;

    /* --- the mine mouth: an excavated portal chamber ------------------ */
    dx = px; dy = py - (A.MINE_CEILING_Y + MOUTH_CY);
    if (dx * dx + dy * dy < MOUTH_R * MOUTH_R) return -1;

    /* --- the floor of the mine --------------------------------------- */
    if (py > floorY) {
      // A ragged top surface so the floor does not read as a drawn line.
      if (py < floorY + SP * 1.5 && hv(S_FLOOR, cx, cy) < 0.35) return M_GRANITE;
      return M_BEDROCK;
    }

    /* --- blobs: motherlode, then cavern, then pocket ------------------ */
    for (i = 0; i < bbN; i++) {
      dx = (px - bbX[i]) / bbRX[i];
      dy = (py - bbY[i]) / bbRY[i];
      t = dx * dx + dy * dy;
      var sh = bbShell[i];
      if (t > sh) continue;

      if (t > 1) {
        /* THE SHELL. This is the glittering wall of the cavern: an annulus of
         * ore just outside the void, ragged on its outer edge so it grades
         * back into rock instead of stopping dead. */
        var e = (t - 1) / (sh - 1);
        if (e > 0.5 && hv(S_RIM, cx ^ bbId[i], cy) < (e - 0.5) / 0.5) continue;
        return bbMat[i];
      }

      if (bbKind[i] === K_POCKET && bbMat[i] >= 0) {
        /* A SOLID ore lens, with an eroded rim so it looks weathered into the
         * rock rather than stamped on top of it. */
        if (t > 0.66 && hv(S_RIM, cx ^ bbId[i], cy) < (t - 0.66) / 0.34 * 0.8) continue;
        return bbMat[i];
      }

      /* OPEN VOID, with spoil piled on the floor. dy > 0 is the lower half:
       * +y is down, and a cavern with a clean floor looks like a bubble. */
      if (dy > 0.42 && hv(S_RIM, cx ^ bbId[i], cy + 7) < RUBBLE_FLOOR * dy) {
        return M_RUBBLE;
      }
      return -1;
    }

    /* --- old workings ------------------------------------------------- */
    for (i = 0; i < drN; i++) {
      if (px > drX0[i] && px < drX1[i] && py > drY0[i] && py < drY1[i]) {
        if (py > drY1[i] - SP && hv(S_RIM, cx ^ drId[i], cy) < 0.38) return M_RUBBLE;
        return -1;
      }
    }

    /* --- ore seam ----------------------------------------------------- */
    if (seamOn) {
      var w = noise1s(px * SEAM_WARP_F + seamJ * 7.31, S_SEAM) * SEAM_WARP;
      var d = py - (seamCy + w);
      if (d < 0) d = -d;
      var pres = noise1(px * SEAM_LENS_F + seamJ * 3.77, S_SEAMM);
      if (pres > seamPinch) {
        var swell = (pres - seamPinch) / (1 - seamPinch);
        if (d < seamHalf * swell) return seamMat;
      }
    }

    /* --- motherlode halo: the readable approach ----------------------
     * Stringers of the lode material, thickening as you close on the chamber.
     * This is the "you are getting close" signal that costs the player nothing
     * to read: it is simply in the wall in front of them, and it gets richer.
     * ---------------------------------------------------------------- */
    for (i = 0; i < hlN; i++) {
      dx = (px - hlX[i]) / hlRX[i];
      dy = (py - hlY[i]) / hlRY[i];
      var ht = Math.sqrt(dx * dx + dy * dy);
      if (ht <= 1 || ht > HALO_T) continue;
      var g = 1 - (ht - 1) / (HALO_T - 1);
      if (hv(S_HALO, cx, cy) < HALO_MAX * g * g) return hlMat[i];
    }

    /* --- country rock, in beds --------------------------------------- */
    return bedMaterial(px, py, cx, cy, L);
  }

  /**
   * THE STRATA. A layer is two or three interbedded rocks on a warped pitch.
   * render() reconstructs the SAME boundary curve (see drawStrata), so the
   * painted seam in the background lines up with the material change in the
   * deposits and a wall reads as one continuous bed rather than as texture
   * with rocks in front of it.
   */
  function bedMaterial(px, py, cx, cy, L) {
    if (!L) return M_STONE;
    var warp = noise1s(px * BED_WARP_F, S_BED + L.idx) * BED_WARP;
    var bi = Math.floor((py + warp) / L.bedPitch);
    var m = pickWeighted(L.beds, hv(S_BEDM, bi, L.idx));
    // Nodules: a small fraction of cells take a different bed's material, so
    // a bed has grain instead of being a flat fill.
    if (hv(S_SPECK, cx, cy) < BED_SPECK) {
      m = pickWeighted(L.beds, hv(S_SPECK, cx + 1013, cy));
    }
    return m;
  }

  /* ======================================================================
   * DROPPED CARGO
   *
   * A pile is cargo the player tipped out (or lost to a strand). It has to
   * come back when the band streams in again — that is what makes "I'll come
   * back for the coal" true. We take OWNERSHIP of adv.js's piles as they
   * appear (its contract is consumePile-on-respawn) and keep our own list, so
   * a pile survives the band streaming out and in repeatedly, not just once.
   * =================================================================== */
  var PILE_MAX = 64;
  var PILE_SLOTS = 12;                     // max particles one pile spawns
  /* KEEP-CLEAR. A pile must not materialise under the machine that just tipped
   * it out, because the collector would vacuum it straight back into the hold —
   * dumping the coal to make room for gold then did nothing at all. Tip it out,
   * drive off, and the heap is there on the floor behind you. Sized off the
   * live magnet radius plus a margin so it holds for every collector upgrade. */
  var PILE_CLEAR_PAD = 90;
  var PILE_NEAR = 170;                     // slot-still-belongs-to-this-pile radius

  var plX = new Float32Array(PILE_MAX);
  var plY = new Float32Array(PILE_MAX);
  var plMat = new Int32Array(PILE_MAX);
  var plUnits = new Float32Array(PILE_MAX);
  var plUp = new Uint8Array(PILE_MAX);      // 1 = currently spawned as particles
  var plPer = new Float32Array(PILE_MAX);   // cargo units per spawned particle
  var plNum = new Int32Array(PILE_MAX);     // how many particles it spawned
  var plSlot = new Int32Array(PILE_MAX * PILE_SLOTS);
  var plN = 0;

  function addPile(x, y, m, units) {
    if (plN >= PILE_MAX) return;
    plX[plN] = x; plY[plN] = y; plMat[plN] = m;
    plUnits[plN] = units > 0 ? units : 1;
    plUp[plN] = 0;
    plPer[plN] = 0;
    plNum[plN] = 0;
    plN++;
  }

  /** Swap-remove, keeping every parallel array and the slot block in step. */
  function dropPileRecord(i) {
    var last = plN - 1;
    if (i !== last) {
      plX[i] = plX[last]; plY[i] = plY[last]; plMat[i] = plMat[last];
      plUnits[i] = plUnits[last]; plUp[i] = plUp[last];
      plPer[i] = plPer[last]; plNum[i] = plNum[last];
      var a = i * PILE_SLOTS, b = last * PILE_SLOTS;
      for (var k = 0; k < PILE_SLOTS; k++) plSlot[a + k] = plSlot[b + k];
    }
    plN = last;
  }

  /**
   * A PILE IS A FINITE HEAP. Retire the record once the ore it spawned has
   * actually been picked up, and shrink it when only part of it has.
   *
   * Without this the record lived forever: every time the band streamed out and
   * back the heap respawned in full, so one dumped unit of gold was an
   * unlimited supply — dump, drive off, come back, collect, repeat. Measured at
   * roughly double payout on the first return trip alone.
   *
   * "Picked up" and "the band unloaded" look identical if you only count
   * particles, so this runs AFTER releasePilesOutside() and only inspects piles
   * still flagged `plUp` — a heap whose row has left the slab has already been
   * released and is skipped, which is what keeps it waiting on the floor.
   *
   * A slot is only still ours if it is LOOSE, carries our material and sits near
   * the heap: the pool recycles slot indices, so identity alone would count a
   * stranger's fragment as our coal. COLLECTED is deliberately NOT alive — it is
   * already flying into the hopper. A refused pickup (a full hold) leaves the
   * fragment LOOSE, so a heap you cannot carry stays exactly where it is.
   */
  function retireTakenPiles() {
    if (!plN) return;
    var d = SM.particles.data;
    var LOOSE = SM.particles.LOOSE;
    var near2 = PILE_NEAR * PILE_NEAR;

    /* ORE ONLY LEAVES BY BEING PICKED UP, AND PICKING UP ONLY HAPPENS HERE.
     * Fragments also vanish for a reason that has nothing to do with the
     * player: the streamer culls loose debris by Y, on a line that does not
     * line up with the row boundaries this module tracks, so a heap can lose
     * its particles while its row still counts as resident. Reading that as
     * "collected" retired heaps the player never even saw — measured, with the
     * record hitting zero while the machine was driving away from it.
     *
     * So a heap is only allowed to CHANGE while the machine is close enough to
     * have taken it. Anywhere else, an empty heap just means it is not
     * currently materialised: drop the flag and let it come back. */
    var vx = SM.vehicle && SM.vehicle.getX ? SM.vehicle.getX() : 0;
    var vy = SM.vehicle && SM.vehicle.getY ? SM.vehicle.getY() : 0;
    var take = PILE_NEAR;
    if (SM.vehicle && SM.vehicle.getCollectRadius) {
      var cr = SM.vehicle.getCollectRadius();
      if (cr > take) take = cr;
    }
    var take2 = take * take;

    for (var i = plN - 1; i >= 0; i--) {
      if (!plUp[i] || plNum[i] <= 0) continue;

      var base = i * PILE_SLOTS, alive = 0;
      for (var k = 0; k < plNum[i]; k++) {
        var s = plSlot[base + k];
        if (s < 0) continue;
        if (d.state[s] !== LOOSE || d.mat[s] !== plMat[i]) continue;
        var dx = d.x[s] - plX[i], dy = d.y[s] - plY[i];
        if (dx * dx + dy * dy > near2) continue;
        alive++;
      }

      var mdx = plX[i] - vx, mdy = plY[i] - vy;
      var couldTake = (mdx * mdx + mdy * mdy) <= take2;

      if (!couldTake) {
        // Out of reach, so nothing here was picked up. If the fragments are
        // gone anyway the streamer took them: un-flag it so the heap comes back
        // next time its row is filled, and leave the tally untouched.
        if (alive <= 0) plUp[i] = 0;
        continue;
      }

      if (alive <= 0) { dropPileRecord(i); continue; }
      if (alive < plNum[i]) {
        // Partly cleared: keep the remainder honest for the next visit.
        plUnits[i] = plPer[i] * alive;
        plNum[i] = alive;
        var w = 0;
        for (var k2 = 0; k2 < PILE_SLOTS; k2++) {
          var s2 = plSlot[base + k2];
          if (s2 < 0) continue;
          if (d.state[s2] !== LOOSE || d.mat[s2] !== plMat[i]) continue;
          var ex = d.x[s2] - plX[i], ey = d.y[s2] - plY[i];
          if (ex * ex + ey * ey > near2) continue;
          plSlot[base + w++] = s2;
        }
        while (w < PILE_SLOTS) plSlot[base + w++] = -1;
      }
    }
  }

  /** Adopt anything adv.js has dropped since the last check. */
  function adoptPiles() {
    if (!SM.adv || !SM.adv.getPiles) return;
    var src = SM.adv.getPiles();
    if (!src || !src.length) return;
    for (var i = src.length - 1; i >= 0; i--) {
      var p = src[i];
      if (p && p.length >= 3) addPile(p[0], p[1], p[2] | 0, p[3]);
      if (SM.adv.consumePile) SM.adv.consumePile(i);
    }
  }

  /**
   * Spawn every heap that is ready and inside the given world rectangle.
   * The rectangle is 2D now, exactly like the window: a heap dumped 900 units
   * off to one side must NOT materialise while it is outside the resident
   * window, or the pool pays for particles nobody can see and
   * retireTakenPiles() has to reason about heaps it cannot reach.
   */
  function spawnPilesInRect(xLo, yTop, xHi, yBot) {
    /* The keep-clear disc travels with the machine — see PILE_CLEAR_PAD. */
    var hasV = !!(SM.vehicle && SM.vehicle.getX);
    var vx = hasV ? SM.vehicle.getX() : 0;
    var vy = hasV ? SM.vehicle.getY() : 0;
    var reach = PILE_CLEAR_PAD;
    if (SM.vehicle && SM.vehicle.getCollectRadius) {
      var cr = SM.vehicle.getCollectRadius();
      if (cr > 0) reach += cr;
    }
    var reach2 = reach * reach;

    for (var i = 0; i < plN; i++) {
      if (plUp[i]) continue;
      if (plY[i] < yTop || plY[i] >= yBot) continue;
      if (plX[i] < xLo || plX[i] >= xHi) continue;
      if (hasV) {
        var ddx = plX[i] - vx, ddy = plY[i] - vy;
        if (ddx * ddx + ddy * ddy < reach2) continue;   // wait until we drive off
      }
      var m = plMat[i];
      var mat = SM.materials.get(m);
      var vol = 1;
      if (SM.mines && SM.mines.volumeOf) {
        var v = SM.mines.volumeOf(mat.id);
        if (v > 0.05) vol = v;
      }
      var n = Math.round(plUnits[i] / vol);
      if (n < 1) n = 1; else if (n > PILE_SLOTS) n = PILE_SLOTS;
      var r = mat.radius[0] * 0.62;
      /* Remember the slots, and what share of the heap each one carries, so
       * retireTakenPiles() can tell "the player picked this up" from "the band
       * unloaded" and shrink the heap to what is genuinely still lying there. */
      var base = i * PILE_SLOTS, got = 0;
      var per = plUnits[i] / n;
      for (var k = 0; k < n; k++) {
        var a = (k / n) * 6.2831853 + hv(S_FLOOR, i, k) * 1.7;
        var d = 6 + hv(S_FLOOR, i + 71, k) * 26;
        var slot = SM.particles.spawnLoose(plX[i] + Math.cos(a) * d, plY[i] + Math.sin(a) * d,
                                m, 0, 0, r);
        if (slot >= 0) plSlot[base + got++] = slot;
      }
      while (got < PILE_SLOTS) plSlot[base + got++] = -1;
      plNum[i] = 0;
      for (var q = 0; q < PILE_SLOTS; q++) if (plSlot[base + q] >= 0) plNum[i]++;
      plPer[i] = per;
      // The pool was full and nothing spawned: leave the heap un-materialised
      // rather than flagging it up, or it would be retired as "taken".
      if (plNum[i] <= 0) continue;
      plUp[i] = 1;
    }
  }

  /**
   * Spawn any heap that is ready, EVERY step — not only when its row happens to
   * be generated.
   *
   * Piles used to materialise purely as a side effect of row generation, which
   * stopped working the moment the keep-clear rule could decline a spawn: the
   * row is already resident by then, generation never revisits it, and the heap
   * you just tipped out never appeared at all. Retrying here is what makes
   * "drive off and it is lying there behind you" actually happen.
   */
  function spawnReadyPiles() {
    if (!plN || !haveN) return;
    var anyDown = false;
    for (var i = 0; i < plN; i++) { if (!plUp[i]) { anyDown = true; break; } }
    if (!anyDown) return;
    spawnPilesInRect(colEdgeX(haveC0), rowTopY(haveR0),
                     colEdgeX(haveC1), rowTopY(haveR1));
  }

  /**
   * A pile whose particles the streamer has just freed is no longer spawned, so
   * it will be re-spawned the next time the window covers it. The rectangle
   * passed in is therefore the KEEP rect (the one loose particles are culled
   * against), not the solid window: a heap must be un-flagged exactly when its
   * fragments die, or retireTakenPiles() sees an empty heap in reach of nothing
   * and the record drifts.
   */
  function releasePilesOutside(xLo, yTop, xHi, yBot) {
    for (var i = 0; i < plN; i++) {
      if (!plUp[i]) continue;
      if (plY[i] < yTop || plY[i] >= yBot || plX[i] < xLo || plX[i] >= xHi) plUp[i] = 0;
    }
  }

  /* ======================================================================
   * STREAMING
   * =================================================================== */

  function focusX() {
    if (focusOn) return focusFX;
    return (SM.vehicle && SM.vehicle.getX) ? SM.vehicle.getX() : 0;
  }
  function focusY() {
    if (focusOn) return focusFY;
    return (SM.vehicle && SM.vehicle.getY) ? SM.vehicle.getY() : A.MINE_CEILING_Y;
  }

  /**
   * SIZE AND PLACE THE WINDOW.
   *
   * The camera decides what has to be resident; the pool decides what may be.
   * So: take the view, ask for ADV.STREAM_MARGIN of slack around it, and then
   * spend the cell budget in a fixed order of priority —
   *
   *   1. COVER THE VIEW. A hole in the middle of the screen is the one failure
   *      the player can actually see, so the visible rectangle is bought first
   *      and only given up if it does not fit on its own (a very wide viewport;
   *      see the note below).
   *   2. BUY MARGIN, EQUALLY IN WORLD UNITS ON ALL FOUR SIDES, with whatever is
   *      left. Solving 4*(hw+m)*(hh+m) = budget for m is what makes this one
   *      number instead of a pair of fudge factors, and equal margins are what
   *      make driving sideways feel the same as driving down.
   *   3. NEVER CROSS THE HASH WRAP (WIN_MAX_W / WIN_MAX_H).
   *
   * A viewport so wide that even the bare view does not fit (past about 21:9 at
   * ADV.CAM_ZOOM) is shrunk uniformly instead: the far corners of such a screen
   * then show unstreamed rock, which is dark, rather than a corrupted spatial
   * hash, which is a bug. Before 2D windowing that screen showed bedrock walls
   * for the same reason.
   *
   * The centre follows the machine and may drift toward the camera by at most
   * WINDOW_BIAS of the half-extent on each axis, which is what guarantees the
   * machine can never be outside its own terrain.
   */
  function computeWindow(fx, fy) {
    var hw = WINDOW_MIN_HALF, hh = WINDOW_MIN_HALF;
    var camX = fx, camY = fy;
    if (SM.camera && SM.camera.getViewBounds) {
      var v = SM.camera.getViewBounds();
      var vw = (v.maxX - v.minX) * 0.5;
      var vh = (v.maxY - v.minY) * 0.5;
      if (vw > hw) hw = vw;
      if (vh > hh) hh = vh;
      camX = (v.minX + v.maxX) * 0.5;
      camY = (v.minY + v.maxY) * 0.5;
    }

    var cells = A.SOLID_BUDGET / FILL_ESTIMATE * trim;
    var area = cells * SP * SP;                    // world units the pool covers

    // 1 + 2: how much margin the leftovers buy, on all four sides.
    var m = A.STREAM_MARGIN;
    if (4 * (hw + m) * (hh + m) > area) {
      // m^2 + (hw+hh)m + (hw*hh - area/4) = 0
      var b = hw + hh;
      var disc = b * b - 4 * (hw * hh - area * 0.25);
      m = disc > 0 ? (-b + Math.sqrt(disc)) * 0.5 : -1;
      if (m < 0) {
        // The view alone is unaffordable: shrink it, keeping its shape.
        var s = Math.sqrt(area / (4 * hw * hh));
        hw *= s; hh *= s;
        m = 0;
      }
    }
    hw += m; hh += m;

    // 3: the spatial hash's wrap, with margin. See the header.
    var maxHW = (WIN_MAX_W - LOOSE_KEEP_PAD * 2) * 0.5;
    var maxHH = (WIN_MAX_H - LOOSE_KEEP_PAD * 2) * 0.5;
    if (hw > maxHW) hw = maxHW;
    if (hh > maxHH) hh = maxHH;
    if (hw < SP * 3) hw = SP * 3;
    if (hh < SP * 3) hh = SP * 3;

    var bx = camX - fx, by = camY - fy;
    var limX = hw * WINDOW_BIAS, limY = hh * WINDOW_BIAS;
    if (bx > limX) bx = limX; else if (bx < -limX) bx = -limX;
    if (by > limY) by = limY; else if (by < -limY) by = -limY;
    var cx = fx + bx, cy = fy + by;
    winL = cx - hw; winR = cx + hw;
    winTop = cy - hh; winBot = cy + hh;

    if (winR - winL > peakWinW) peakWinW = winR - winL;
    if (winBot - winTop > peakWinH) peakWinH = winBot - winTop;
  }

  /** Free every particle in the world. Used when the window jumps. */
  function flushAll() {
    SM.particles.despawnAhead(1e12);
    haveN = false;
    for (var i = 0; i < plN; i++) plUp[i] = 0;
  }

  /**
   * Recycle down to the desired cell rectangle.
   *
   * TWO RECTANGLES, AND THE OUTER ONE IS NOT OPTIONAL.
   *
   * The inner call frees embedded terrain only (keepLoose), because loose ore is
   * the player's property: debris you shook out of the wall behind you is still
   * lying there when you reverse, and a dumped heap is made of loose particles.
   *
   * The outer call, LOOSE_KEEP_PAD further out, frees everything. Without it
   * loose material would never be collected at all — a heap dumped 3000 units
   * away would stay live for the whole descent, which leaks the pool AND, far
   * worse, puts two live particles more than 2944 units apart, which is where
   * particles.js's wrapped spatial hash starts aliasing them into the same cell.
   * It is also what the old despawnBehind/despawnAhead pair did for free.
   *
   * Both rectangles are clamped to the hash box around the machine, so however
   * the window is placed the live extent stays inside one wrap.
   *
   * The cut lines are exact CELL boundaries: rowTopY() and colEdgeX(). A
   * deposit's jitter cannot reach either of them (see the header), so a strip is
   * never half-recycled — a half strip would be regenerated on top of its own
   * survivors at double density.
   */
  function trimTo(c0, c1, r0, r1) {
    var xL = colEdgeX(c0), xR = colEdgeX(c1);
    var yT = rowTopY(r0), yB = rowTopY(r1);
    SM.particles.despawnOutsideRect(xL, yT, xR, yB, true);

    var kL = xL - LOOSE_KEEP_PAD, kR = xR + LOOSE_KEEP_PAD;
    var kT = yT - LOOSE_KEEP_PAD, kB = yB + LOOSE_KEEP_PAD;
    var mx = focusX(), my = focusY();
    var hx = WIN_MAX_W * 0.5, hy = WIN_MAX_H * 0.5;
    if (kL < mx - hx) kL = mx - hx;
    if (kR > mx + hx) kR = mx + hx;
    if (kT < my - hy) kT = my - hy;
    if (kB > my + hy) kB = my + hy;
    SM.particles.despawnOutsideRect(kL, kT, kR, kB, false);

    if (haveC0 < c0) haveC0 = c0;
    if (haveC1 > c1) haveC1 = c1;
    if (haveR0 < r0) haveR0 = r0;
    if (haveR1 > r1) haveR1 = r1;
    if (haveC0 >= haveC1 || haveR0 >= haveR1) haveN = false;
    releasePilesOutside(kL, kT, kR, kB);

    if (kR - kL > peakLiveW) peakLiveW = kR - kL;
    if (kB - kT > peakLiveH) peakLiveH = kB - kT;
  }

  /**
   * Is there room in the pool for `n` more deposits?
   * `+ n` and not `>=`: a strip is up to n deposits, so testing the budget
   * against the CURRENT count lets one whole strip over the ceiling. It measured
   * 75 deposits of overshoot before this said what it meant.
   */
  function canAfford(n) {
    var st = SM.particles.getStats();
    if (st.free < DEBRIS_RESERVE + n + 8) return false;
    return st.solid + n <= A.SOLID_BUDGET;
  }

  /**
   * Fill cells [c0, c1) of row cy. Returns false when the pool is too tight to
   * afford the strip, which is the graceful failure: streaming pauses for a step
   * or two while the debris in flight is collected or despawned.
   *
   * Columns outside [0, cols) are simply skipped — they are outside the mine,
   * and they have no mask byte, which is also why the mask index is computed
   * from the clamped range.
   */
  function generateRowStrip(cy, c0, c1) {
    if (c0 < 0) c0 = 0;
    if (c1 > cols) c1 = cols;
    if (c1 <= c0) return true;
    if (!canAfford(c1 - c0)) return false;

    if (cy < 0) return true;                       // open air above the mouth

    var yMid = rowMidY(cy);
    var stag = rowStagger(cy);
    var cx, px;

    if (yMid > deepestY) deepestY = yMid;

    /* Below the modelled floor there is nothing but bedrock — no layers, no
     * structures, no mask (the mask deliberately stops a little way down, so a
     * hole cut in the bedrock heals: the bottom of the mine is the bottom). */
    if (cy >= rows) {
      var brad = Math.min(11, SM.materials.get(M_BEDROCK).radius[0] * RAD_GAIN);
      for (cx = c0; cx < c1; cx++) {
        px = x0 + (cx + 0.5) * SP + stag;
        SM.particles.spawnSolid(px, yMid, M_BEDROCK, brad);
      }
      return true;
    }

    var L = layers.length ? layers[layerIndexAtY(yMid)] : null;
    prepareRow(cy, yMid, L, colEdgeX(c0), colEdgeX(c1));

    var base = cy * cols;
    var lim = HALF_W - 6;
    for (cx = c0; cx < c1; cx++) {
      if (mask[base + cx]) continue;               // already dug out
      px = x0 + (cx + 0.5) * SP + stag + (hv(S_JX, cx, cy) * 2 - 1) * SP * JITTER_X;
      if (px < -lim || px > lim) continue;
      var py = yMid + (hv(S_JY, cx, cy) * 2 - 1) * SP * JITTER;

      var m = cellMaterialAt(cx, cy, px, py, L);
      if (m < 0) continue;
      var mm = SM.materials.get(m);
      var rad = mm.radius[0] + hv(S_SPECK, cx, cy + 4099) * (mm.radius[1] - mm.radius[0]);
      rad *= RAD_GAIN;
      if (rad > C.SPRITE_MAX_RADIUS) rad = C.SPRITE_MAX_RADIUS;
      SM.particles.spawnSolid(px, py, m, rad);
    }
    return true;
  }

  /**
   * Fill column cx of rows [r0, r1) — the lateral half of the job.
   *
   * It costs one prepareRow() per row for a single cell of output, which sounds
   * wasteful and is not: the gather is asked about a 21-unit-wide slice of rock,
   * so it looks at one or two structure cells per family rather than the two
   * dozen a full-width row needs. Measured, a column strip of 60 rows costs
   * about the same as two full row strips.
   */
  function generateColStrip(cx, r0, r1) {
    if (cx < 0 || cx >= cols) return true;
    if (r1 <= r0) return true;
    if (!canAfford(r1 - r0)) return false;
    for (var cy = r0; cy < r1; cy++) generateRowStrip(cy, cx, cx + 1);
    return true;
  }

  /**
   * Fill the whole rectangle, rows outward from the focus row.
   *
   * Used for the one-shot fill when a mine is entered and whenever the window
   * jumps clear of what we hold. Row-major on purpose: one prepareRow() per row
   * instead of one per cell of a column walk, which is the difference between a
   * 60-row fill costing 60 gathers and costing 5000.
   *
   * OUTWARD FROM THE FOCUS, so that if the pool refuses a row the resident
   * rectangle stays contiguous AND the machine keeps the terrain nearest it.
   */
  function fillRect(c0, c1, r0, r1, fy) {
    haveC0 = c0; haveC1 = c1;
    var mid = cellYOf(fy);
    if (mid < r0) mid = r0; else if (mid >= r1) mid = r1 - 1;
    haveR0 = mid; haveR1 = mid;
    haveN = true;
    var down = true;
    while (haveR0 > r0 || haveR1 < r1) {
      var canDown = haveR1 < r1, canUp = haveR0 > r0;
      down = canDown && (!canUp || down);
      if (down) {
        if (!generateRowStrip(haveR1, c0, c1)) break;
        haveR1++;
        down = false;
      } else {
        if (!generateRowStrip(haveR0 - 1, c0, c1)) break;
        haveR0--;
        down = true;
      }
    }
    // Nothing at all got in (a pool that tight can only happen mid-run): claim
    // nothing, and the next step tries again.
    if (haveR1 <= haveR0) haveN = false;
  }

  /**
   * One streaming pass. `maxCells` bounds the work: CELLS_PER_STEP while
   * playing, unbounded for the one-shot fill when a mine is entered.
   */
  function streamPass(maxCells) {
    var fx = focusX(), fy = focusY();
    computeWindow(fx, fy);

    wantC0 = colOfX(winL);
    wantC1 = colOfX(winR) + 1;
    wantR0 = cellYOf(winTop);
    wantR1 = cellYOf(winBot) + 1;
    if (wantC1 <= wantC0) wantC1 = wantC0 + 1;
    if (wantR1 <= wantR0) wantR1 = wantR0 + 1;

    if (!haveN || haveC1 <= wantC0 || haveC0 >= wantC1 ||
        haveR1 <= wantR0 || haveR0 >= wantR1) {
      /* The window has jumped clear of what we hold — a descent, a re-entry, a
       * teleport in a test. Start over rather than stitching two disjoint
       * rectangles together. */
      flushAll();
      fillRect(wantC0, wantC1, wantR0, wantR1, fy);
      sweepTick = 0;
      return;
    }

    if (++sweepTick >= DESPAWN_INTERVAL) {
      sweepTick = 0;
      trimTo(wantC0, wantC1, wantR0, wantR1);
      if (!haveN) { flushAll(); fillRect(wantC0, wantC1, wantR0, wantR1, fy); return; }
    }

    /* GROW THE NEAREST EDGE FIRST. A hole 40 units from the drill matters; a
     * hole 900 units behind the machine does not. Distances are measured from
     * the machine to each of the four edges, and the smallest one is the edge
     * that gets this iteration's strip. */
    var budget = maxCells;
    var rowN = haveC1 - haveC0;
    var colN = haveR1 - haveR0;
    while (budget > 0) {
      var dL = (haveC0 > wantC0) ? (fx - colEdgeX(haveC0)) : 1e12;
      var dR = (haveC1 < wantC1) ? (colEdgeX(haveC1) - fx) : 1e12;
      var dT = (haveR0 > wantR0) ? (fy - rowTopY(haveR0)) : 1e12;
      var dB = (haveR1 < wantR1) ? (rowTopY(haveR1) - fy) : 1e12;
      var best = dL, which = 0;
      if (dR < best) { best = dR; which = 1; }
      if (dT < best) { best = dT; which = 2; }
      if (dB < best) { best = dB; which = 3; }
      if (best > 1e11) break;                      // nothing left to grow

      if (which === 0) {
        if (!generateColStrip(haveC0 - 1, haveR0, haveR1)) break;
        haveC0--; budget -= colN;
      } else if (which === 1) {
        if (!generateColStrip(haveC1, haveR0, haveR1)) break;
        haveC1++; budget -= colN;
      } else if (which === 2) {
        if (!generateRowStrip(haveR0 - 1, haveC0, haveC1)) break;
        haveR0--; budget -= rowN;
      } else {
        if (!generateRowStrip(haveR1, haveC0, haveC1)) break;
        haveR1++; budget -= rowN;
      }
      rowN = haveC1 - haveC0;
      colN = haveR1 - haveR0;
    }
  }

  /**
   * Watch the pool and shrink the window if the geology turns out to be denser
   * than FILL_ESTIMATE guessed. This is the belt to the braces in
   * generateRowStrip(): that one stops streaming, this one gives the space back.
   */
  function adaptBudget() {
    var st = SM.particles.getStats();
    if (st.solid > peakSolid) peakSolid = st.solid;
    if (st.free < lowFree) lowFree = st.free;
    if (st.solid > A.SOLID_BUDGET * BUDGET_EASE || st.free < DEBRIS_RESERVE) {
      trim -= TRIM_DOWN;
      if (trim < TRIM_MIN) trim = TRIM_MIN;
    } else if (trim < 1) {
      trim += TRIM_UP;
      if (trim > 1) trim = 1;
    }
  }

  /* ======================================================================
   * LAYER AND MOTHERLODE AWARENESS
   * =================================================================== */
  var lastLayer = -1;
  var ANN_MAX = 12;
  var annIds = new Int32Array(ANN_MAX);
  var annN = 0;

  function trackLayer(fy) {
    if (!layers.length) return;
    var li = layerIndexAtY(fy);
    if (li === lastLayer) return;
    lastLayer = li;
    evLayer.name = layers[li].name;
    evLayer.depthM = depthOfY(fy);
    SM.events.emit('mine:layer', evLayer);
    // A new layer is a new set of rock: a real scanner would be re-run here.
    if (SM.scanner && SM.scanner.ping) SM.scanner.ping();
  }

  function announced(id) {
    for (var i = 0; i < annN; i++) if (annIds[i] === id) return true;
    return false;
  }

  /** Fire `mine:lode` the first time the machine comes near a motherlode. */
  function trackLode(fx, fy) {
    if (!gldValid || annN >= ANN_MAX) return;
    var j0 = Math.floor((fy - LODE_ANNOUNCE - LODE_H) / LODE_H);
    var j1 = Math.floor((fy + LODE_ANNOUNCE + LODE_H) / LODE_H);
    var i0 = cellI0(fx, LODE_W, LODE_ANNOUNCE + LODE_W);
    var i1 = cellI1(fx, LODE_W, LODE_ANNOUNCE + LODE_W);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        if (!lodeOfCell(i, j)) continue;
        testLodeAnnounce(fx, fy, lodeX, lodeY, lodeMat, lodeId);
      }
    }
    testLodeAnnounce(fx, fy, gldX, gldY, gldMat, gldId);
  }

  function testLodeAnnounce(fx, fy, lx, ly, m, id) {
    if (announced(id)) return;
    var dx = fx - lx, dy = fy - ly;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > LODE_ANNOUNCE) return;
    if (annN < ANN_MAX) annIds[annN++] = id;
    evLode.x = lx; evLode.y = ly; evLode.matIndex = m; evLode.dist = d;
    SM.events.emit('mine:lode', evLode);
  }

  /* ======================================================================
   * MINE LIFECYCLE
   * =================================================================== */

  function beginMine(def, mineState) {
    resolveMaterials();

    mineDef = def || null;
    mineStateRef = mineState || null;
    mineSeed = (def && typeof def.seed === 'number') ? (def.seed | 0) : 1337;
    mineDepthM = (def && def.depth > 0) ? def.depth : 400;
    floorY = yOfDepth(mineDepthM);

    buildGrid();
    allocMask();
    buildLayers(def);
    buildGuaranteedLode();
    buildTiles();

    /* Restore the tunnels. Two possible providers, because the mask lives in
     * save.js's record but is this module's array: prefer an already-decoded
     * Uint8Array, fall back to asking save.js to decode its RLE string. A
     * corrupt mask costs the player their tunnels and nothing else. */
    if (mineState) {
      var m = mineState.mask;
      if (m && m.length && typeof m !== 'string') {
        importMask(m);
      } else if (typeof m === 'string' && m.length &&
                 SM.save && SM.save.decodeMask) {
        var u8 = null;
        try { u8 = SM.save.decodeMask(m, cols * rows); } catch (e) { u8 = null; }
        if (u8) importMask(u8);
      }
      // Piles left underground last visit.
      if (mineState.piles && mineState.piles.length) {
        for (var i = 0; i < mineState.piles.length; i++) {
          var p = mineState.piles[i];
          if (p && p.length >= 3) addPile(p[0], p[1], p[2] | 0, p[3]);
        }
      }
    }

    deepestY = A.MINE_CEILING_Y;
    lastLayer = -1;
    annN = 0;
    trim = 1;
    peakSolid = 0;
    lowFree = 1e9;
    haveN = false;
    sweepTick = 0;
    active = true;
    loaded = true;

    // Fill the whole window now: entering a mine is a screen transition, so this
    // is the one moment a few thousand spawns in one step costs nothing.
    streamPass(1e9);
    spawnReadyPiles();
    SM.particles.rebuildGrid();
    trackLayer(focusY());
  }

  /**
   * End the RUN and hand the mask back for saving. Also writes the still-buried
   * piles into the mine's save record if it has one, so dropped cargo survives
   * a session and not just a band recycle.
   *
   * Deliberately does NOT unload the geology — see the two-flag note at the top.
   * The extraction card, the world map and the workshop all render over a live
   * mine, and dropping the layer table here is what made them render over the
   * classic time-attack lane instead. unload() is the other half.
   */
  function endMine() {
    var out = '';
    if (mask && SM.save && SM.save.encodeMask) {
      try { out = SM.save.encodeMask(mask) || ''; } catch (e) { out = ''; }
    }
    if (mineStateRef) {
      try {
        var arr = [];
        for (var i = 0; i < plN; i++) arr.push([plX[i], plY[i], plMat[i], plUnits[i]]);
        mineStateRef.piles = arr;
      } catch (e2) { /* a save record we cannot write is not a crash */ }
    }
    active = false;
    plN = 0;
    haveN = false;
    mineStateRef = null;
    return out;
  }

  /**
   * Forget the mine entirely. Optional: js/terrain.js already stops delegating
   * the moment SM.adv.isActive() goes false, so leaving the campaign restores
   * the classic world without anyone calling this. It exists so adv.close() can
   * be explicit if Agent 1 prefers.
   */
  function unload() {
    active = false;
    loaded = false;
    plN = 0;
    haveN = false;
    mineStateRef = null;
    mineDef = null;
  }

  /**
   * Re-descend the SAME mine: clear the streamed window and refill around the
   * machine. The mask survives, deliberately — the tunnels the player dug are
   * the mine's history, not the run's.
   */
  function reset() {
    if (!active) return;
    flushAll();
    deepestY = A.MINE_CEILING_Y;
    lastLayer = -1;
    trim = 1;
    peakSolid = 0;
    lowFree = 1e9;
    sweepTick = 0;
    for (var i = 0; i < plN; i++) plUp[i] = 0;
    streamPass(1e9);
    spawnReadyPiles();
    SM.particles.rebuildGrid();
    trackLayer(focusY());
  }

  /**
   * ONE FIXED STEP. Reached through js/terrain.js's adventure branch, so it is
   * called exactly once per step, in terrain's slot in main.js's order — before
   * vehicle.update(), which is what guarantees the cutter never reaches rock
   * that has not been generated.
   *
   * IT ALSO DRIVES THE SCANNER. Nothing in the frozen loop calls
   * SM.scanner.update(): main.js's order predates it and adv.js's contract does
   * not mention it. Rather than ask for a change to a frozen file, the world
   * module drives the instrument that reads the world, with `stepId` as the
   * token that makes a duplicate call from anywhere else a no-op.
   */
  var stepId = 0;

  function update(dt) {
    if (!active) return;
    adoptPiles();
    streamPass(CELLS_PER_STEP);
    spawnReadyPiles();
    // AFTER streaming: releasePilesOutside() has already un-flagged any heap
    // whose fragments the sweep freed, so what is left flagged is genuinely
    // resident and a missing fragment really was collected. Order is the whole
    // correctness argument here — see retireTakenPiles().
    retireTakenPiles();
    var fy = focusY();
    trackLayer(fy);
    trackLode(focusX(), fy);
    adaptBudget();
    if (SM.scanner && SM.scanner.update) SM.scanner.update(dt, ++stepId);
  }

  function init() {
    resolveMaterials();
    SM.events.on('material:destroyed', onDestroyed);
  }

  /** HOT: up to ~150 per step. One integer decode and one byte write. */
  function onDestroyed(p) {
    if (!active) return;
    markDestroyed(p.x, p.y);
  }

  function isActive() { return active; }

  /* ======================================================================
   * QUERIES
   * =================================================================== */
  function depthOfY(y) {
    var d = (y - A.MINE_CEILING_Y) * A.METERS_PER_UNIT;
    return d > 0 ? d : 0;
  }
  function yOfDepth(m) { return A.MINE_CEILING_Y + m / A.METERS_PER_UNIT; }
  function getGeneratedTo() { return deepestY; }

  /* ----- scanner support ---------------------------------------------
   * The scanner's whole point is seeing ore behind rock that has NOT streamed
   * in, so these answer from the generator. They do not walk cells either:
   * every ore body in this world is a STRUCTURE with a centre and a size, so
   * we enumerate the structures whose grid cells fall inside the range and
   * report one contact per FORMATION. That is both far cheaper than a cell
   * walk and a better answer — "one signature per seam" is what an instrument
   * would say, where a cell walk would return a cloud of dots.
   * ------------------------------------------------------------------ */

  var SCAN_MAX = 8;

  /**
   * Contact slots are allocated LAZILY INTO THE CALLER'S ARRAY and then reused
   * forever, which is why probeAll() takes an `out` rather than returning one.
   * A shared pool would be a real bug here: js/scanner.js keeps its contacts
   * across sweeps and hangs its own display state on them, so a call to
   * probe() from anywhere else would silently rewrite the live HUD readout.
   * One array, one set of objects, at most SCAN_MAX of them, ever.
   */
  function slotIn(out, i) {
    var s = out[i];
    if (!s) {
      s = { x: 0, y: 0, matIndex: 0, dist: 0, strength: 0, size: 0 };
      out[i] = s;
    }
    return s;
  }

  /** Rough "how big a deal is this" score, 0..1. */
  function contactStrength(m, rx, ry, dist, range) {
    var v = SM.materials.get(m).baseValue;
    var vol = Math.sqrt(rx * ry);
    var raw = (v * vol) / 4200;                 // ~1 for a decent gold pocket
    if (raw > 1) raw = 1;
    var near = 1 - (dist / range) * 0.55;
    return raw * (near > 0 ? near : 0);
  }

  var scanN = 0;
  function addContact(out, x, y, m, dist, strength, size) {
    if (!SM.materials.get(m).ore) return;        // spoil is not a signature
    var i;
    // Merge with an existing contact of the same material close by, so one
    // formation reported twice stays one contact.
    for (i = 0; i < scanN; i++) {
      var c = out[i];
      if (c.matIndex !== m) continue;
      var dx = c.x - x, dy = c.y - y;
      if (dx * dx + dy * dy < 260 * 260) {
        if (strength > c.strength) {
          c.x = x; c.y = y; c.dist = dist; c.strength = strength; c.size = size;
        }
        return;
      }
    }
    if (scanN < SCAN_MAX) {
      var s = slotIn(out, scanN);
      s.x = x; s.y = y; s.matIndex = m; s.dist = dist;
      s.strength = strength; s.size = size;
      scanN++;
      return;
    }
    // Full: displace the weakest contact if this one beats it.
    var worst = 0;
    for (i = 1; i < scanN; i++) if (out[i].strength < out[worst].strength) worst = i;
    if (strength > out[worst].strength) {
      var w = out[worst];
      w.x = x; w.y = y; w.matIndex = m; w.dist = dist;
      w.strength = strength; w.size = size;
    }
  }

  function tryContact(out, x, y, m, rx, ry, px, py, range) {
    if (m < 0) return;
    var dx = x - px, dy = y - py;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > range) return;
    // A formation the player has already mined out should stop answering.
    if (isCarved(x, y)) return;
    addContact(out, x, y, m, d, contactStrength(m, rx, ry, d, range),
               Math.sqrt(rx * ry));
  }

  /**
   * Every ore formation within `range` of (x, y), written into the caller's
   * array as {x, y, matIndex, dist, strength, size}. -> count written.
   */
  function probeAll(px, py, range, out) {
    scanN = 0;
    if (!loaded || !out || !(range > 0)) return 0;
    var i, j, L;

    /* --- motherlodes (including the guaranteed one) ------------------- */
    var j0 = Math.floor((py - range - LODE_H) / LODE_H);
    var j1 = Math.floor((py + range + LODE_H) / LODE_H);
    var li0 = cellI0(px, LODE_W, range + LODE_W);
    var li1 = cellI1(px, LODE_W, range + LODE_W);
    for (j = j0; j <= j1; j++) {
      for (i = li0; i <= li1; i++) {
        if (!lodeOfCell(i, j)) continue;
        tryContact(out, lodeX, lodeY, lodeMat, lodeRX * 1.35, lodeRY * 1.35, px, py, range);
      }
    }
    if (gldValid) {
      tryContact(out, gldX, gldY, gldMat, gldRX * 1.35, gldRY * 1.35, px, py, range);
    }

    /* --- pockets and mineralised caverns ------------------------------ */
    var pi0 = Math.floor((px - range) / POCKET_W), pi1 = Math.floor((px + range) / POCKET_W);
    var pj0 = Math.floor((py - range) / POCKET_H), pj1 = Math.floor((py + range) / POCKET_H);
    for (j = pj0; j <= pj1; j++) {
      for (i = pi0; i <= pi1; i++) {
        var cyw = j * POCKET_H + hv(S_POCK, i * 17 + 5, j) * POCKET_H;
        L = layerAtY(cyw);
        if (!L || L.pocketP <= 0) continue;
        if (hv(S_POCK, i, j) >= L.pocketP) continue;
        if (hv(S_POCKM, i, j) < L.vug) continue;             // hollow, no ore
        var big = hv(S_POCK, i * 17 + 1, j) < POCKET_BIG;
        var rx = big
          ? lerp(POCKET_MAX_R, POCKET_BIG_R, hv(S_POCK, i * 17 + 2, j))
          : lerp(POCKET_MIN_R, POCKET_MAX_R, hv(S_POCK, i * 17 + 2, j));
        var ryd = rx * lerp(0.48, 0.95, hv(S_POCK, i * 17 + 3, j));
        var cxw = i * POCKET_W + hv(S_POCK, i * 17 + 4, j) * POCKET_W;
        tryContact(out, cxw, cyw, pickWeighted(L.ores, hv(S_POCKM, i + 5, j)),
                   rx, ryd, px, py, range);
      }
    }
    var ci0 = Math.floor((px - range) / CAVERN_W), ci1 = Math.floor((px + range) / CAVERN_W);
    var cj0 = Math.floor((py - range) / CAVERN_H), cj1 = Math.floor((py + range) / CAVERN_H);
    for (j = cj0; j <= cj1; j++) {
      for (i = ci0; i <= ci1; i++) {
        if (hv(S_CAVM, i, j) >= CAVERN_MINERAL) continue;
        var ccy = j * CAVERN_H + hv(S_CAV, i * 31 + 4, j) * CAVERN_H;
        L = layerAtY(ccy);
        if (!L || L.cavernP <= 0 || !L.ores) continue;
        if (hv(S_CAV, i, j) >= L.cavernP) continue;
        var crx = lerp(CAVERN_MIN_R, CAVERN_MAX_R, hv(S_CAV, i * 31 + 1, j));
        var cry = crx * lerp(0.44, 0.86, hv(S_CAV, i * 31 + 2, j));
        var ccx = i * CAVERN_W + hv(S_CAV, i * 31 + 3, j) * CAVERN_W;
        tryContact(out, ccx, ccy, pickWeighted(L.ores, hv(S_CAVM, i + 13, j)),
                   crx, cry, px, py, range);
      }
    }

    /* --- seams: report the nearest point on the bed, not its centre --- */
    var s0 = Math.floor((py - range) / SEAM_PITCH), s1 = Math.floor((py + range) / SEAM_PITCH);
    for (j = s0; j <= s1; j++) {
      var scy = (j + 0.18 + hv(S_SEAM, j, 101) * 0.64) * SEAM_PITCH;
      L = layerAtY(scy);
      if (!L || L.seamP <= 0 || !L.ores) continue;
      if (hv(S_SEAM, j, L.idx) >= L.seamP) continue;
      var half = SP * lerp(0.7, 2.3, hv(S_SEAM, j, 202));
      var pinch = lerp(0.30, 0.64, hv(S_SEAM, j, 303));
      // Walk a few sample x positions across the range: a seam is long, so the
      // contact should be the part of it nearest the machine.
      var bestD = 1e12, bestX = 0, bestY = 0, bestSw = 0;
      for (var k = -3; k <= 3; k++) {
        var sx = px + k * (range / 3);
        if (sx < -HALF_W || sx > HALF_W) continue;
        var pres = noise1(sx * SEAM_LENS_F + j * 3.77, S_SEAMM);
        if (pres <= pinch) continue;
        var sw = (pres - pinch) / (1 - pinch);
        var sy = scy + noise1s(sx * SEAM_WARP_F + j * 7.31, S_SEAM) * SEAM_WARP;
        var dx = sx - px, dy = sy - py;
        var d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; bestX = sx; bestY = sy; bestSw = sw; }
      }
      if (bestD < 1e12) {
        tryContact(out, bestX, bestY, pickWeighted(L.ores, hv(S_SEAMM, j, L.idx)),
                   half * bestSw * 5, half * bestSw, px, py, range);
      }
    }

    return scanN;
  }

  var probeOut = [];
  function probe(x, y, range) {
    var n = probeAll(x, y, range, probeOut);
    if (!n) return null;
    var best = probeOut[0];
    for (var i = 1; i < n; i++) if (probeOut[i].strength > best.strength) best = probeOut[i];
    return best;
  }

  /* ======================================================================
   * BACKGROUND RENDERING
   *
   * The deposits are the mine; this is what is BEHIND them, and it does three
   * jobs. It makes intact ground read as rock rather than as a hole where a
   * deposit failed to spawn (which matters at the slab's edge, where there
   * genuinely are no deposits). It draws the STRATA — the same warped bed
   * boundaries bedMaterial() used, so a wall reads as one continuous bed. And
   * it carries the two diegetic hints: timber sets in the old workings, and a
   * faint bloom of a motherlode's colour through the rock in front of it.
   * =================================================================== */
  var BG_TILE = 128;
  var rockPattern = null, wallPattern = null;
  var tileSeed = 0;

  function tileRnd() {
    tileSeed = (tileSeed + 0x6D2B79F5) >>> 0;
    var t = Math.imul(tileSeed ^ (tileSeed >>> 15), 1 | tileSeed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function noiseTile(r0, g0, b0, spread, speckle) {
    var cv = document.createElement('canvas');
    cv.width = cv.height = BG_TILE;
    var g = cv.getContext('2d');
    g.fillStyle = 'rgb(' + r0 + ',' + g0 + ',' + b0 + ')';
    g.fillRect(0, 0, BG_TILE, BG_TILE);
    for (var i = 0; i < speckle; i++) {
      var f = (tileRnd() * 2 - 1) * spread;
      var r = Math.max(0, Math.min(255, r0 + f)) | 0;
      var gg = Math.max(0, Math.min(255, g0 + f)) | 0;
      var b = Math.max(0, Math.min(255, b0 + f)) | 0;
      g.fillStyle = 'rgb(' + r + ',' + gg + ',' + b + ')';
      var s = 2 + tileRnd() * 8;
      g.fillRect(tileRnd() * BG_TILE, tileRnd() * BG_TILE, s, s);
    }
    return cv;
  }

  function buildTiles() {
    if (rockPattern) return;
    tileSeed = 20240811;
    var rock = noiseTile(30, 26, 24, 13, 900);
    var wall = noiseTile(58, 53, 62, 24, 780);
    var probeCtx = document.createElement('canvas').getContext('2d');
    rockPattern = probeCtx.createPattern(rock, 'repeat');
    wallPattern = probeCtx.createPattern(wall, 'repeat');
  }

  /** Cheap rgba() from a material's shadow colour. */
  function tintOf(matIndex, alpha) {
    var hex = SM.materials.get(matIndex).colors[1];
    var r = 0, g = 0, b = 0;
    if (hex.charAt(0) === '#' && hex.length >= 7) {
      r = parseInt(hex.substr(1, 2), 16);
      g = parseInt(hex.substr(3, 2), 16);
      b = parseInt(hex.substr(5, 2), 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  }

  /**
   * The strata. For every visible bed boundary of every visible layer, draw
   * the SAME curve the generator used: bedMaterial() places a boundary where
   * py + warp(px) = bi * pitch, so the drawn line is py = bi*pitch - warp(px).
   * Ten samples across the shaft is plenty for a 30-unit amplitude.
   */
  function drawStrata(ctx, vLeft, vTop, vRight, vBot) {
    /* SAMPLE ACROSS THE VIEW, NOT ACROSS THE MINE. This used to walk ten
     * samples across the whole shaft, which was fine at 1760 units wide and is
     * nonsense at 5200: the warp's period is 1/BED_WARP_F ~ 476 units, so ten
     * samples over 5200 units alias the curve into a random zig-zag that does
     * not follow the material change the generator made. A fixed WORLD step
     * keeps the drawn boundary on the curve whatever the mine's width, and only
     * the visible span is drawn. */
    var step = 56;
    var w = vRight - vLeft;
    var samples = Math.ceil(w / step);
    if (samples < 4) samples = 4;
    if (samples > 80) { samples = 80; step = w / 80; }
    var lines = 0;
    for (var li = 0; li < layers.length && lines < 90; li++) {
      var L = layers[li];
      var top = li === 0 ? A.MINE_CEILING_Y : layers[li - 1].toY;
      var bot = L.toY;
      if (bot < vTop || top > vBot) continue;
      var a = Math.max(top, vTop), b = Math.min(bot, vBot);

      // The layer's own tone, so a boundary between layers is visible even
      // where no deposit happens to sit on it.
      ctx.fillStyle = tintOf(L.fill, 0.42);
      ctx.fillRect(vLeft, a, w, b - a);

      var pitch = L.bedPitch;
      var bi0 = Math.floor((a - BED_WARP) / pitch);
      var bi1 = Math.ceil((b + BED_WARP) / pitch);
      for (var bi = bi0; bi <= bi1 && lines < 90; bi++) {
        lines++;
        ctx.beginPath();
        for (var s = 0; s <= samples; s++) {
          var px = vLeft + s * step;
          var y = bi * pitch - noise1s(px * BED_WARP_F, S_BED + L.idx) * BED_WARP;
          if (s === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
        }
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0,0,0,0.34)';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        ctx.stroke();
      }

      // Layer name, once, at its ceiling. Anchored to the middle of the VIEW:
      // in a 520-metre-wide mine a caption at x = 0 is a caption the player
      // usually cannot see.
      if (top > vTop - 60 && top < vBot + 60 && top > A.MINE_CEILING_Y) {
        ctx.strokeStyle = 'rgba(255,196,64,0.22)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(vLeft, top); ctx.lineTo(vRight, top);
        ctx.stroke();
        ctx.font = 'bold 26px ui-sans-serif, system-ui, Arial, sans-serif';
        ctx.fillStyle = 'rgba(255,222,150,0.16)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(L.name, (vLeft + vRight) * 0.5, top - 26);
      }
    }
  }

  /** Timber sets in the abandoned drifts: somebody was here before you. */
  function drawTimbers(ctx, vLeft, vTop, vRight, vBot) {
    var j0 = Math.floor((vTop - DRIFT_H) / DRIFT_H);
    var j1 = Math.floor((vBot + DRIFT_H) / DRIFT_H);
    var i0 = cellI0(vLeft, DRIFT_W, DRIFT_MAX_W + DRIFT_W);
    var i1 = cellI1(vRight, DRIFT_W, DRIFT_MAX_W + DRIFT_W);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        // Resolved through driftOfCell(), the same call the generator makes, or
        // timbers would be painted across solid rock (and drifts would be left
        // bare) near a layer boundary.
        if (!driftOfCell(i, j)) continue;
        var yc = dfY, h = dfH, w = dfW;
        if (yc + h < vTop || yc - h > vBot) continue;
        if (dfX + w * 0.5 < vLeft || dfX - w * 0.5 > vRight) continue;
        var xA = dfX - w * 0.5, xB = dfX + w * 0.5;
        var yA = yc - h * 0.5, yB = yc + h * 0.5;

        // Excavated floor, darker than the rock so the drift reads as a hole.
        ctx.fillStyle = 'rgba(12,10,10,0.55)';
        ctx.fillRect(xA, yA, w, h);

        ctx.fillStyle = 'rgba(86,58,34,0.85)';
        var n = Math.floor(w / DRIFT_TIMBER_PITCH);
        for (var k = 0; k <= n; k++) {
          var tx = xA + (k / Math.max(1, n)) * w;
          ctx.fillRect(tx - 3, yA, 6, h);                  // post
        }
        ctx.fillRect(xA, yA - 4, w, 7);                    // cap beam
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(xA, yB - 3, w, 4);                    // sill shadow
      }
    }
  }

  /**
   * A motherlode bleeding its colour through the rock. Deliberately faint: it
   * is not a marker, it is a reason to look twice at one wall out of thirty.
   */
  function drawLodeGlow(ctx, vLeft, vTop, vRight, vBot) {
    var j0 = Math.floor((vTop - LODE_H) / LODE_H);
    var j1 = Math.floor((vBot + LODE_H) / LODE_H);
    var i0 = cellI0(vLeft, LODE_W, LODE_W);
    var i1 = cellI1(vRight, LODE_W, LODE_W);
    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        if (!lodeOfCell(i, j)) continue;
        lodeBloom(ctx, lodeX, lodeY, lodeRX, lodeRY, lodeMat, vTop, vBot);
      }
    }
    if (gldValid) lodeBloom(ctx, gldX, gldY, gldRX, gldRY, gldMat, vTop, vBot);
  }

  function lodeBloom(ctx, lx, ly, rx, ry, m, vTop, vBot) {
    var reach = Math.max(rx, ry) * 2.6;
    if (ly + reach < vTop || ly - reach > vBot) return;
    var col = SM.materials.get(m).colors[0];
    var g = ctx.createRadialGradient(lx, ly, 0, lx, ly, reach);
    g.addColorStop(0, hexToRgba(col, 0.20));
    g.addColorStop(0.55, hexToRgba(col, 0.07));
    g.addColorStop(1, hexToRgba(col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(lx - reach, ly - reach, reach * 2, reach * 2);
  }

  function hexToRgba(hex, a) {
    var r = 255, g = 255, b = 255;
    if (hex.charAt(0) === '#' && hex.length >= 7) {
      r = parseInt(hex.substr(1, 2), 16);
      g = parseInt(hex.substr(3, 2), 16);
      b = parseInt(hex.substr(5, 2), 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /** Daylight and a timbered portal at the mine mouth. */
  function drawMouth(ctx, v, vTop) {
    var ceil = A.MINE_CEILING_Y;
    if (vTop > ceil) return;
    /* Daylight over a FIXED distance, not over the visible slice. Anchoring the
     * bright end to vTop meant that on the framing the camera actually uses at
     * the mouth (camera.js caps the sky at ADV_SKY_PEEK) only the dark end of
     * the ramp was ever on screen, and the surface read as more rock. */
    var top = ceil - SKY_DEPTH;
    var g = ctx.createLinearGradient(0, top, 0, ceil);
    g.addColorStop(0, '#8194ab');
    g.addColorStop(0.45, '#4d5464');
    g.addColorStop(1, '#14131a');
    var fx = v.minX - 60, fw = (v.maxX - v.minX) + 120;
    if (vTop < top) {
      ctx.fillStyle = '#8194ab';
      ctx.fillRect(fx, vTop - 60, fw, top - vTop + 60);
    }
    ctx.fillStyle = g;
    ctx.fillRect(fx, top, fw, ceil - top);

    // The portal frame, spanning the mouth chamber.
    var w = MOUTH_R * 1.5;
    ctx.fillStyle = '#5a3d24';
    ctx.fillRect(-w * 0.5 - 14, ceil - 18, w + 28, 22);
    ctx.fillRect(-w * 0.5 - 14, ceil - 4, 18, 90);
    ctx.fillRect(w * 0.5 - 4, ceil - 4, 18, 90);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-w * 0.5, ceil + 4, w, 12);
  }

  function render(ctx) {
    // `loaded`, not `active`: the mine stays on screen behind the extraction
    // card, the map and the workshop. See the two-flag note at the top.
    if (!loaded) return;
    var v = SM.camera.getViewBounds();
    var vTop = v.minY - 40, vBot = v.maxY + 40;

    /* --- bedrock AROUND the shaft, then the mine's rock inside it -------
     * This used to paint bedrock across the WHOLE view and then paint the
     * shaft's rock on top of ~85% of it — two full-screen REPEATING-PATTERN
     * fills per frame, where a pattern costs far more per pixel than a solid
     * because every pixel does a modulo address and a texture fetch. It was
     * measured at 14.4 ms/frame: stubbing this function alone took the mode
     * from 36 fps to 74, while particles.render sat at 0.92 ms either way.
     *
     * (Whichever draw call happens to force the rasterisation flush gets
     * billed for it, which is why per-function canvas timings first pointed at
     * particles.render. Bisecting by stubbing whole stages is the measurement
     * that actually holds up.)
     *
     * So paint bedrock ONLY where the shaft's own fill will not cover it: the
     * slivers left and right of the shaft, and the cap above the mine mouth.
     * Same pixels on screen, a little under half the pattern area. This is
     * what classic terrain.js has always done — one pattern fill, and walls
     * only where the view actually extends past the lane.
     * ---------------------------------------------------------------- */
    var sTop = Math.max(vTop, A.MINE_CEILING_Y);
    var wallL = v.minX - 60, wallR = v.maxX + 60;

    /* EVERY FILL BELOW IS CLIPPED TO THE VIEW, NOT TO THE MINE. At 1760 units
     * wide the shaft was about one screen across and "fill the shaft" and "fill
     * the screen" were the same rectangle. At 5200 they are not: filling the
     * shaft would hand the rasteriser two and a half screens of repeating
     * pattern per frame to throw away, and that pattern fill is the single most
     * expensive thing this file does (see the measurement above). */
    var rockL = wallL > -HALF_W ? wallL : -HALF_W;
    var rockR = wallR < HALF_W ? wallR : HALF_W;

    ctx.fillStyle = wallPattern || '#3a3540';
    // The cap above the mine mouth, full view width.
    if (sTop > vTop) ctx.fillRect(wallL, vTop, wallR - wallL, sTop - vTop);
    // The two slivers flanking the shaft, for the rest of the view.
    if (sTop < vBot) {
      if (wallL < -HALF_W) ctx.fillRect(wallL, sTop, -HALF_W - wallL, vBot - sTop);
      if (wallR > HALF_W) ctx.fillRect(HALF_W, sTop, wallR - HALF_W, vBot - sTop);
    }

    if (sTop < vBot && rockR > rockL) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(rockL, sTop, rockR - rockL, vBot - sTop);
      ctx.clip();

      ctx.fillStyle = rockPattern || '#231f1d';
      ctx.fillRect(rockL, sTop, rockR - rockL, vBot - sTop);

      drawStrata(ctx, rockL, sTop, rockR, vBot);
      drawLodeGlow(ctx, rockL, sTop, rockR, vBot);
      drawTimbers(ctx, rockL, sTop, rockR, vBot);

      // Ambient occlusion where the shaft meets its walls — only when a wall is
      // actually on screen.
      if (rockL < -HALF_W + 70) {
        var gl = ctx.createLinearGradient(-HALF_W, 0, -HALF_W + 70, 0);
        gl.addColorStop(0, 'rgba(0,0,0,0.6)');
        gl.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gl;
        ctx.fillRect(-HALF_W, sTop, 70, vBot - sTop);
      }
      if (rockR > HALF_W - 70) {
        var gr = ctx.createLinearGradient(HALF_W, 0, HALF_W - 70, 0);
        gr.addColorStop(0, 'rgba(0,0,0,0.6)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(HALF_W - 70, sTop, 70, vBot - sTop);
      }

      ctx.restore();
    }

    /* --- THE BOTTOM OF THE MINE ---------------------------------------
     * Bedrock is hardness 26, which is not a wall — a stubborn player WILL
     * eventually chew a deposit of it, and pay for every second in fuel and in
     * hull grind. So it has to be unmistakable before they start: a hazard band
     * and a word, not a subtle change of rock. Verified in testing by driving
     * into it and watching the hull lose the argument. */
    if (floorY > vTop - 200 && floorY < vBot && rockR > rockL) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,96,84,0.40)';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(rockL, floorY); ctx.lineTo(rockR, floorY);
      ctx.stroke();
      // Diagonal hazard hatching in the first few metres of the floor. Stepped
      // across the VIEW: at 5200 units wide, hatching the whole mine is 130
      // strokes of which a handful are on screen.
      ctx.beginPath();
      ctx.rect(rockL, floorY, rockR - rockL, 46);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,96,84,0.16)';
      ctx.lineWidth = 9;
      ctx.beginPath();
      var hx0 = Math.floor((rockL - 46) / 40) * 40;
      for (var hx = hx0; hx < rockR; hx += 40) {
        ctx.moveTo(hx, floorY + 48); ctx.lineTo(hx + 48, floorY);
      }
      ctx.stroke();
      ctx.restore();
      ctx.font = 'bold 24px ui-sans-serif, system-ui, Arial, sans-serif';
      ctx.fillStyle = 'rgba(255,150,140,0.30)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('BEDROCK', (rockL + rockR) * 0.5, floorY - 12);
    }

    drawMouth(ctx, v, vTop);

    /* --- depth ruler, in metres --------------------------------------
     * The label used to sit just outside the far wall, which worked while the
     * whole shaft was on screen. In a 520-metre-wide mine it never is, so the
     * label rides the left edge of the view instead: a depth ruler you cannot
     * read is decoration, and this one is the only in-world depth cue. */
    var stepU = 100;                      // 10 m
    var first = Math.ceil((vTop - A.MINE_CEILING_Y) / stepU) * stepU;
    var last = vBot - A.MINE_CEILING_Y;
    var labelX = v.minX + 14;
    if (labelX < -HALF_W + 14) labelX = -HALF_W + 14;
    ctx.lineWidth = 1;
    ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (var d = first; d <= last; d += stepU) {
      if (d < 0) continue;
      var wy = A.MINE_CEILING_Y + d;
      var major = (d % 500) === 0;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.085)' : 'rgba(255,255,255,0.035)';
      ctx.beginPath();
      ctx.moveTo(rockL, wy); ctx.lineTo(rockR, wy);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = 'rgba(255,255,255,0.20)';
        ctx.fillText((d * A.METERS_PER_UNIT) + ' m', labelX, wy);
      }
    }

    /* --- shaft edge trim --------------------------------------------- */
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,196,64,0.22)';
    ctx.beginPath();
    if (wallL < -HALF_W + 4) { ctx.moveTo(-HALF_W, sTop); ctx.lineTo(-HALF_W, vBot); }
    if (wallR > HALF_W - 4) { ctx.moveTo(HALF_W, sTop); ctx.lineTo(HALF_W, vBot); }
    ctx.stroke();
  }

  /* ======================================================================
   * DIAGNOSTICS
   * Everything below is for measurement and for scripted tests. Nothing in
   * the game depends on it.
   * =================================================================== */
  var dbg = {
    cols: 0, rows: 0, carved: 0, maskBytes: 0,
    winL: 0, winR: 0, winTop: 0, winBot: 0, winW: 0, winH: 0,
    haveC0: 0, haveC1: 0, haveR0: 0, haveR1: 0, cells: 0,
    peakWinW: 0, peakWinH: 0, peakLiveW: 0, peakLiveH: 0,
    trim: 1, cellBudget: 0, peakSolid: 0, lowFree: 0, solid: 0, free: 0,
    piles: 0, pilesUp: 0, deepestM: 0, layer: ''
  };
  function getDebug() {
    var st = SM.particles.getStats();
    dbg.cols = cols; dbg.rows = rows; dbg.carved = carved;
    dbg.maskBytes = mask ? mask.length : 0;
    dbg.winL = winL; dbg.winR = winR;
    dbg.winTop = winTop; dbg.winBot = winBot;
    dbg.winW = winR - winL; dbg.winH = winBot - winTop;
    dbg.haveC0 = haveC0; dbg.haveC1 = haveC1;
    dbg.haveR0 = haveR0; dbg.haveR1 = haveR1;
    dbg.cells = haveN ? (haveC1 - haveC0) * (haveR1 - haveR0) : 0;
    /* THE HASH AUDIT. peakLive* is the widest and tallest the KEEP rect has ever
     * been, which is the outermost box any live particle can sit in. Both must
     * stay under particles.js's 2944 x 5888 wrap or collision detection starts
     * pairing particles that are nowhere near each other. */
    dbg.peakWinW = peakWinW; dbg.peakWinH = peakWinH;
    dbg.peakLiveW = peakLiveW; dbg.peakLiveH = peakLiveH;
    dbg.trim = trim; dbg.cellBudget = cellBudget;
    dbg.peakSolid = peakSolid; dbg.lowFree = lowFree;
    dbg.solid = st.solid; dbg.free = st.free;
    dbg.piles = plN;
    var up = 0;
    for (var i = 0; i < plN; i++) if (plUp[i]) up++;
    dbg.pilesUp = up;
    dbg.deepestM = depthOfY(deepestY);
    dbg.layer = (lastLayer >= 0 && layers[lastLayer]) ? layers[lastLayer].name : '';
    return dbg;
  }
  function resetPeaks() {
    peakSolid = 0; lowFree = 1e9;
    peakWinW = 0; peakWinH = 0; peakLiveW = 0; peakLiveH = 0;
  }

  /**
   * The material a cell WOULD contain, resolved straight from the generator with
   * no streaming involved: the determinism test asks for a region's materials,
   * drives away until it unloads, comes back and asks again. -1 means "empty".
   * Exported for tests only; nothing in the game calls it.
   */
  function cellMaterial(cx, cy) {
    if (!loaded) return -2;
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) return -2;
    if (mask[cy * cols + cx]) return -1;
    var yMid = rowMidY(cy);
    var stag = rowStagger(cy);
    var px = x0 + (cx + 0.5) * SP + stag + (hv(S_JX, cx, cy) * 2 - 1) * SP * JITTER_X;
    var py = yMid + (hv(S_JY, cx, cy) * 2 - 1) * SP * JITTER;
    var L = layers.length ? layers[layerIndexAtY(yMid)] : null;
    // The SAME gather range a one-column strip uses, so this asks the generator
    // exactly what generateColStrip() would have asked it.
    prepareRow(cy, yMid, L, colEdgeX(cx), colEdgeX(cx + 1));
    return cellMaterialAt(cx, cy, px, py, L);
  }

  var mlOut = { x: 0, y: 0, rx: 0, ry: 0, matIndex: 0, depthM: 0 };

  /** Streaming follows the vehicle unless something overrides it here. */
  function setFocusOverride(x, y) { focusOn = true; focusFX = x; focusFY = y; }
  function clearFocusOverride() { focusOn = false; }

  return {
    init: init,
    isActive: isActive,
    beginMine: beginMine,
    endMine: endMine,
    /** True while a mine's geology is still resolved and drawable. */
    isLoaded: function () { return loaded; },
    unload: unload,
    update: update,
    reset: reset,
    render: render,

    markDestroyed: markDestroyed,
    isCarved: isCarved,
    exportMask: exportMask,
    importMask: importMask,
    maskDims: maskDims,

    depthOfY: depthOfY,
    yOfDepth: yOfDepth,
    layerAtY: layerAtY,
    getGeneratedTo: getGeneratedTo,
    probe: probe,
    probeAll: probeAll,

    /* --- additions beyond the stub (documented in the report) ---------- */
    /** Resolved layer table of the live mine: name/toY/heat/hardnessScale. */
    getLayers: function () { return layers; },
    /** The material ids this generator places. js/mines.js prices these. */
    getMaterialIds: function () { return MAT_IDS; },
    /** Where the machine gets in and out. */
    getMouthX: function () { return 0; },
    getMouthY: function () { return A.MINE_CEILING_Y + MOUTH_CY * 0.35; },
    /** Depth in metres of the bedrock floor of the live mine. */
    getFloorDepthM: function () { return depthOfY(floorY); },
    /** How many cells the player has dug out of this mine, ever. */
    getCarvedCount: function () { return carved; },
    /** The mine's guaranteed motherlode, or null. REUSED object. */
    getMotherlode: function () {
      if (!gldValid) return null;
      mlOut.x = gldX; mlOut.y = gldY; mlOut.matIndex = gldMat;
      mlOut.rx = gldRX; mlOut.ry = gldRY;
      mlOut.depthM = depthOfY(gldY);
      return mlOut;
    },
    getDebug: getDebug,
    resetPeaks: resetPeaks,
    /** Grid geometry + the generator's answer for one cell. Tests only. */
    cellMaterial: cellMaterial,
    cellOfPoint: function (x, y, out) {
      var o = out || {};
      o.cy = cellYOf(y);
      o.cx = cellXOf(x, o.cy);
      return o;
    },
    setFocusOverride: setFocusOverride,
    clearFocusOverride: clearFocusOverride
  };
})();
