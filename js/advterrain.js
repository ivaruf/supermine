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
 *   MOUTH CHAMBER   an excavated portal at the top of the ELEVATOR COLUMN — the
 *                   mine's west corner — so the machine is not born buried, and
 *                   so EXIT_RADIUS is reachable.
 *   THE LIFT        the one piece of geology that is not geology: a vertical
 *                   shaft at the mine's WEST EDGE (ELEV_X, just inside the
 *                   bedrock wall), carved down to the deepest STATION the player
 *                   owns, with a chamber that opens EASTWARD into the field, a
 *                   platform, worklights, a cage and a big red depth readout at
 *                   each of them. It is INFRASTRUCTURE — derived from
 *                   SM.adv.getLevels() at GENERATION time and never written into
 *                   the carve mask, so it exists in bands nobody has visited and
 *                   vanishes again in a save that never bought the level. It is
 *                   also OUTSIDE THE WORKINGS: the whole span east of it is
 *                   uninterrupted diggable geology. See "THE LIFT" below.
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

  /* --- THE ELEVATOR'S X: THE MINE'S WEST EDGE --------------------------
   * The lift is a TRANSPORT COLUMN OUTSIDE THE WORKINGS, not a road through the
   * middle of them. It used to be sunk down x = 0, and a shaft down the centre of
   * a 5200-unit mine is not an elevator: it is a pair of rails with the field
   * split in half around them, and every run began by driving down a corridor the
   * player already owned. Moving it to the west edge does two things at once —
   * the whole span east of it becomes ONE uninterrupted body of diggable rock,
   * and the levels stop being waypoints on a road and become landings that open
   * off a column, which is the shape a real mine has.
   *
   * THE INSET IS SET BY WHAT HANGS OFF THE COLUMN, NOT BY TASTE. The carved
   * shaft is only SHAFT_HALF (150) either side of ELEV_X, but four other things
   * stand further west than that and every one of them would end up drawn on
   * bedrock at a smaller inset:
   *
   *   the shaft's own timber LINING           at -150 .. -137
   *   each station's BACK WALL (STATION_BACK)  at -186
   *   the station HEADFRAME's west post        at -174 .. -161
   *   the surface PORTAL's west post           at -198
   *
   * ...plus render() paints the wall trim and a 70-unit ambient-occlusion
   * gradient inward from -HALF_W, which would land on that timber rather than on
   * rock. MEASURED at 210, which is what this was first built at: the portal's
   * west post and the west festoon string both stood in the rock rind, and the
   * station headframe's west post stood outside the room it is supposed to be
   * inside.
   *
   * BUT THE NUMBER IS ACTUALLY SET BY THE MACHINE'S OWN WALL CLAMP, and that was
   * the surprise. js/vehicle.js holds the hull centre at least advRadius() from
   * the bedrock (`bound = MINE_HALF_WIDTH - rad`), and advRadius() is the
   * CIRCUMSCRIBED reach — a top-tier rig trails a hopper and a conveyor, and it
   * measures 438.7 units. So the machine physically cannot get closer to the west
   * wall than x = -2161, whatever it is asked to do. The cage it has to board is a
   * circle of ADV.EXIT_RADIUS (200) about (ELEV_X, stationY) and the park sits
   * ADV_SPAWN_Y (70) below that centre, so the inset has to satisfy
   *
   *     sqrt((advRadius - inset)^2 + ADV_SPAWN_Y^2)  <  EXIT_RADIUS
   *
   * i.e. inset > 251.7 for the rig the workshop actually sells. MEASURED at 250:
   * a maxed rig parked at the surface sat 201.3 units from the cage centre and
   * getBoardable() returned -1 — the lift was unusable at the top of the tech
   * tree, at every station, and nothing about the failure said why.
   *
   * 320 puts the park at ELEV_X + ADV_SPAWN_X = -2130, which is inside the clamp
   * for EVERY rig tier (so the biggest and the smallest machine park in exactly
   * the same place, 165 units from the cage) and leaves 62 units of slack on the
   * boarding radius for whatever js/rig.js grows next. It also gives every one of
   * the four overhangs above 120+ units of real rock behind it. The cost is 70
   * units of field out of 5200 — 1.3% — against a mode-breaking bug.
   *
   * EVERYTHING DOWNSTREAM READS getMouthX(). js/adv.js's getStationX(), the cage
   * circles, the distance-to-exit reserve maths, js/vehicle.js's park and the HUD
   * all resolve the shaft's x through that one getter, so this constant is the
   * only place the number lives.
   * ------------------------------------------------------------------ */
  var ELEV_INSET = 320;
  var ELEV_X = -HALF_W + ELEV_INSET;

  /* --- the mine mouth ------------------------------------------------- */
  var MOUTH_R = 270;           // excavated portal chamber radius
  /* THE PORTAL CHAMBER IS OFFSET EAST OF THE HEADFRAME, and that is the
   * spawn-footprint fix. The machine now parks EAST of the cage facing east (see
   * vehicle.js's ADV_SPAWN_X), so at the surface station its nose reaches about
   * 320 units east of the column — past the edge of a chamber centred on it, i.e.
   * born with the bit inside solid topsoil. Sliding the circle 84 east puts the
   * excavation where the machine actually stands while still covering the full
   * width of the shaft head behind it. Measured: buried-solid count at spawn 0. */
  var MOUTH_DX = 100;
  var MOUTH_CY = 70;           // its centre, world units below MINE_CEILING_Y
  var SKY_DEPTH = 300;         // world units of daylight ramp above the mouth
  /* DAYLIGHT IS LOCAL TO THE ELEVATOR HEAD. With the mouth at the centre of the
   * mine, "the surface" and "the way out" were the same line and the sky was
   * painted across the whole view above MINE_CEILING_Y. At the west edge that
   * would say the opposite of the truth: the workings run 4800 units east of the
   * head and their roof is ROCK. So the sky is a patch over the head that grades
   * into the rock cap, which is also what makes the daylight mean something —
   * one bright place, and it is the one you leave from. */
  var DAY_HALF = 640;          // sky reaches this far EAST of the head...
  var DAY_FADE = 420;          // ...then grades into the rock cap over this
  /* THE DAYLIGHT BLOOM, drawn in renderLit() — the emissive pass — because the
   * darkness composite crushes the sky itself to rgb(8,9,10) past the headlight.
   * Sized so the portal reads from about half a screen away, and no further: it is
   * culled with the mouth (see renderLit), so it is a landmark on the surface
   * rather than a beacon through 300 m of rock, and a deep station pays nothing
   * for it at all.
   *
   * IT IS THE ONE THING IN THIS FILE THAT COSTS FRAMES. One cached radial gradient
   * over a 2R square is 840x840 world units of alpha blending. Measured headless at
   * 1440x900: 44 fps at the surface without it, 41 at R = 470, 42 at R = 420 — and
   * unchanged at depth, because the y guard skips it. 420 is where the landmark is
   * still legible and the bill is under a frame and a half. */
  var DAY_GLOW_R = 420;
  var DAY_GLOW_A = 0.30;
  /* Headframe span, straddling the carved column. A literal rather than
   * SHAFT_HALF * 2 + 68, because SHAFT_HALF is declared further down this block
   * and `var` hoisting would make that read `undefined`. It IS 368 = the 300-unit
   * column plus 34 of bracket each side, and the two must be changed together. */
  var PORTAL_W = 368;
  var FLOOR_PAD_M = 60;        // metres of bedrock modelled below the bottom

  /* --- THE LIFT: the shaft, the stations, and the red readout ----------
   * The mine mouth is a LIFT. The player buys STATIONS at depth, rides between
   * the ones they own for free, and drills OUTWARD from them — so the vertical
   * axis stops being a journey to be re-driven at the start of every run and
   * becomes something they own.
   *
   * All of it is INFRASTRUCTURE, which in this file means one specific thing:
   * it is carved by the GENERATOR out of the set of owned stations, and never
   * through the carve mask. The mask persists what the PLAYER dug and is saved
   * with the company (see the header); the shaft has to be there in bands
   * nobody has ever visited, and it has to be absent again in a save that never
   * bought the level. Ownership in, geology out, no history in between — which
   * is also exactly what keeps generation deterministic: same ownership set,
   * same band, same result, whether the band is met on the way down or refilled
   * from the side an hour later.
   * ------------------------------------------------------------------ */
  var SHAFT_HALF = 150;        // half-width of the carved column. 300 units is
                               // twice the starting cutter, clears the widest
                               // hull in the workshop, and is wide enough to
                               // hang the level board across — so "drive down
                               // your own shaft" never degrades into "grind
                               // down your own shaft".
  var SHAFT_SET_PITCH = 112;   // world units between the shaft's timber sets
  /* THE STATION CHAMBER IS A ROOM, NOT A BUBBLE. The mouth chamber is a circle
   * and reads as a hole blasted into a hillside, which is what it is. A station
   * is excavated to hold a platform, so it is a SUPERELLIPSE (exponent 4):
   * square-ish walls, rounded corners, full width right up to the ceiling.
   *
   * IT IS ASYMMETRIC NOW, AND THAT IS THE WHOLE POINT OF AN EDGE ELEVATOR. The
   * room used to be 600 x 400 centred on the column, which is right when the
   * column runs down the middle of the mine and wrong at its west wall: half that
   * excavation would be carved into — and half the room PAINTED onto — the
   * bedrock the mine ends at. So the shaft is the room's BACK WALL and the
   * excavation runs EAST into the field:
   *
   *   STATION_BACK  the shaft's own width plus the thickness of its lining. Just
   *                 enough that the column passes cleanly through the chamber;
   *                 there is nothing behind it to excavate.
   *   STATION_FWD   the room proper. 560 is sized off THE MACHINE (about 340
   *                 units long with its drill out and 150 wide) plus the cage and
   *                 the deck it drives off: a room that only just contains the
   *                 machine reads as a cupboard.
   *
   * The cage zone js/adv.js boards from is still a circle of EXIT_RADIUS (200)
   * about (ELEV_X, stY), and its WESTERN half is now outside the workings by
   * design — there is no rock over there to stand in. What matters is that the
   * whole eastern half, including where vehicle.js parks, is inside the
   * excavation, so the lift is reachable from anywhere in the room. */
  var STATION_BACK = 186;      // west of the column: the lining and the headframe
                               // post, and no more — there is nothing behind it
  var STATION_FWD = 560;       // east of the column: the room
  var STATION_RY = 200;
  var STATION_MAX = 16;        // stations one mine may hold
  var LIFT_POLL = 8;           // steps between ownership re-reads (see update)
  /* THE SUMP. The shaft is carved this much past the deepest station's floor,
   * and it is where the story of the NEXT level is told: boards across the
   * bottom, and the same depth board switched off. Without it the "closed
   * continuation" would be painted behind solid rock, where nobody can see it —
   * and a station platform with no shaft opening under it does not read as a
   * landing on a shaft at all. */
  var SHAFT_SUMP = 150;
  var HINT_H = 215;            // how far the boarded continuation fades on down
  /* HOW HIGH THE LEVEL BOARD HANGS, as the distance from the station centre to
   * the board's BOTTOM edge.
   *
   * THIS NUMBER IS SET BY THE DARKNESS COMPOSITE, NOT BY THE CARPENTRY. The board
   * used to hang clear above the excavation (STATION_RY + 18 + its own height, so
   * ~330 up), which looked right in a lit screenshot and was invisible in the
   * game: js/effects.js paints a black radial gradient centred on the machine and
   * everything past SM.rig.getLightRadius() is 94% black. A new company's lights
   * are 380, the machine parks ~120 BELOW the station centre and the pool leans
   * another ~60 the way the drill points, so a board 330 above the centre sat
   * ~510 from the light — flat 6% transmission. Measured on a 390-wide phone at
   * the default light tier: the figures were a dark red smear and the stratum row
   * was gone entirely.
   *
   * 120 puts the board's centre ~356 from the pool's centre, which is the SAME
   * BAND THE TWO STATION WORKLIGHTS ARE IN (354) — so it reads as one of the
   * lamps rather than as something painted behind them, which is exactly the
   * brief. It cannot go lower: the parked hull's top is ~30 above the station
   * centre and the cage's roof plate ~35, so this leaves 85-90 units of daylight
   * under the board and the machine still never stands in front of it. It is
   * still IN THE SHAFT and still read from above on the way down; it now simply
   * overlaps the headframe's cap beam, which is where a real level board is
   * bolted anyway (drawStation paints the board after the frame). */
  var BOARD_RISE = 120;

  /* --- THE RAILS: the drift, the chambers, and the track ---------------
   * A LEVEL IS A LANDING; THE RAILS ARE THE ROAD OFF IT. The lift sells DEPTH
   * and it stops at the station room's east mouth (ELEV_X + STATION_FWD). Beyond
   * that the mine is 4,800 units of country rock, the motherlode sits on the
   * centre line, and getting there is the run. A checkpoint is the player buying
   * that distance back: a serviced siding 120 m further out, with a chamber to
   * stand in and a line of track leading to it.
   *
   * SAME OWNERSHIP-IN-GEOLOGY-OUT RULE AS THE SHAFT, and for the same reasons
   * (see "THE LIFT" above). resolveRails() reads SM.adv.getCheckpoints(L) for
   * every owned station at GENERATION time; nothing here is ever written into the
   * carve mask. So the drift exists in bands nobody has driven, it is absent again
   * in a save that never bought the checkpoint, and a band met on the way out is
   * byte-identical to the same band met on the way back.
   *
   * THE CORRIDOR'S HEIGHT IS SET BY THE CUT BOX, NOT BY TASTE. The fast lane
   * (js/vehicle.js's onRail() gate) only pays out while the bit is in CLEAR AIR —
   * advLoad under ADV_TRAVEL_FREE — and js/vehicle.js scans a square box of
   * ADV_CUT_HALF + 8 per blade tier (84 at tier 0, 124 at tier 5) centred on the
   * bit, which particles.js's queryRect answers by CIRCLE OVERLAP, so a deposit
   * of radius 11 still counts 135 units out on a maxed rig. The machine's natural
   * travel line is the one vehicle.js parks it on, ADV_SPAWN_Y (70) BELOW the
   * level's survey line, so the void is deliberately ASYMMETRIC about that line:
   *
   *     RAIL_UP    90    roof, above the survey line   -> 160 over the travel line
   *     RAIL_DOWN 210    floor, below it               -> 140 under the travel line
   *
   * 300 units total, which is exactly the width of the shaft the same machine
   * came down — anything that fits down the column fits along the drift, at every
   * rig tier, with the cut box clear of rock at both. It is a THIN VEIN and it is
   * meant to stay one: 30 m of the stratum's thickness, at four discrete depths,
   * against a mine 520 m wide. Going lower starts costing the fast lane at the top
   * of the tech tree (a tier-5 bit grinds the floor and the gear drops out from
   * under it, with nothing on screen saying why); going higher starts deleting the
   * bed the level exists to sell.
   *
   * THE SOLID BILL IS NEGATIVE. Carving cannot push resident solids UP: the window
   * is sized in CELLS from SOLID_BUDGET / FILL_ESTIMATE (see computeWindow), so a
   * void is a cell that produces no deposit and the count can only fall. Measured
   * with the machine mid-track — see the report.
   * ------------------------------------------------------------------ */
  var RAIL_UP = 90;            // corridor void above the level's survey line
  var RAIL_DOWN = 210;         // ...and below it
  /* The corridor starts INSIDE the station room's east mouth rather than at it.
   * The room is a superellipse, so at its extreme east edge it has pinched to a
   * point: a drift butted onto that x leaves a lens of rock between the two that
   * the player has to cut through on the way out of their own station. */
  var RAIL_MOUTH_BACK = 40;
  /* THE SERVICE CHAMBER — a station room's smaller sibling. 480 x 360 against the
   * station's 746 x 400: wide enough that the whole USABLE x window of the cage
   * (+-187, per the note in ADVENTURE.md 2c — the machine parks below the centre)
   * is inside the excavation, and tall enough to read as a room widening out of
   * the drift rather than as a bulge in it. Centred on the DRIFT, not on the
   * survey line, so its floor and the drift's floor are the same floor. */
  var CP_HW = 240;             // chamber half-width
  var CP_RY = 180;             // chamber half-height
  var CP_DY = (RAIL_DOWN - RAIL_UP) * 0.5;   // 60 — the drift's own centre line
  /* onRail() answers the CORRIDOR minus this on each side. The carve and the fast
   * lane deliberately do not share an edge: a machine grinding along the roof of
   * the drift is not travelling, and a gate that said it was would flicker the
   * gear on and off against the lining. */
  var RAIL_ON_INSET = 26;
  var RAIL_SET_PITCH = 168;    // world units between the drift's timber sets
  var RAIL_GAUGE = 92;         // between the two running rails
  var RAIL_TIE_PITCH = 58;     // sleepers
  var RAIL_MAX = STATION_MAX;  // one run per owned station
  var CP_MAX = 8;              // chambers one run may hold (mines.js sells 4)
  /* Where the CP board hangs: the distance from the level line UP to the board's
   * bottom edge. Same argument as BOARD_RISE — it is set by the darkness
   * composite. The machine's travel line is 70 BELOW the level line, so a board
   * at -52 sits ~122 from the hull centre and ~180 from the light's centre, well
   * inside a starter lamp's 380. It is also the only place it fits: the chamber's
   * roof is at CP_DY - CP_RY = -120, and the board is 62 tall. */
  var CPS_RISE = 52;

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
  /* The GUARANTEED motherlode stays within this of the MINE'S CENTRE LINE, and
   * that line is x = 0 whatever the elevator does. Depth is still the axis of
   * progression, so "go all the way down and there is one waiting" has to survive
   * the mine being 5200 units wide: a headline formation 2400 units off to one
   * side is not a reward, it is a lottery. Rolled lodes are free to be anywhere.
   *
   * DELIBERATELY NOT MOVED WITH THE ELEVATOR. The lift went to the west edge; the
   * FIELD did not move, and re-anchoring this to ELEV_X would regenerate the
   * geology of every seed in the catalogue. The headline formation therefore sits
   * in the middle of the workings — 2400 units of driving east of the column,
   * which is exactly the distance the mode's horizontal progression (levels, and
   * the checkpoints that extend east from them) exists to sell. */
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

  /* ----- the LIFT ------------------------------------------------------
   * Resolved from SM.adv.getLevels() and FEATURE-DETECTED, because Agent 1 owns
   * that array: a build where it is absent must behave exactly as this file did
   * before the lift existed — the mouth, and nothing else.
   *
   * The arrays are sorted SHALLOWEST FIRST, so stY[stN-1] is the deepest owned
   * station and therefore the bottom of the carved shaft.
   * ------------------------------------------------------------------ */
  var liftApi = false;            // getLevels() answered at all
  var stN = 0;
  var stY = new Float32Array(STATION_MAX);
  var stDepthM = new Float32Array(STATION_MAX);
  var stLevel = new Int32Array(STATION_MAX);
  var stArt = [];                 // the pre-rendered readout panel, per station
  var shaftBotY = 0;              // the shaft is carved from the ceiling to here
  /* THE HOT-PATH REJECT. liftXLo/liftXHi bracket every x the lift's excavation
   * can possibly reach, in ABSOLUTE world coordinates — they are not symmetric
   * about anything now, because the room only opens one way. `liftReach` is kept
   * purely as the "is anything carved at all" flag: it is 0 until a station is
   * owned, and that zero test is the only cost cellMaterialAt() pays per cell in
   * the 95% of a 5200-unit mine that is nowhere near the column. */
  var liftReach = 0;
  var liftXLo = 0, liftXHi = 0;
  var nextOn = false;             // is there an unowned level below the last?
  var nextY = 0, nextArt = null;
  var liftSig = -2;               // ownership signature, for the poll
  var liftTick = 0;
  var liftPhase = 0;              // monotonic; drives the station lamp flicker
  var liftFlick = 1;             // last drawLift flicker, reused by renderLit()

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
   * THE LIFT — resolving which stations exist, and opening them
   *
   * THE SEAM. js/adv.js owns the level definitions and publishes them as a LIVE
   * array of {i, name, depthM, y, price, owned}, i = 0 being the surface (the
   * mouth itself, which this module has always drawn). This side of the seam
   * does two things with that: it resolves the OWNED entries into flat arrays
   * once, and it notices when the set changes.
   *
   * IT NOTICES TWICE, ON PURPOSE. `lift:bought` is the fast path — the frame the
   * player presses BUY, the shaft opens. The poll in update() is the backstop,
   * because the alternative to a redundant integer compare eight times a second
   * is a player staring at solid rock where a station they just paid for should
   * be, and that is not a failure mode worth being tidy about.
   * =================================================================== */

  /** The live level array, or null while Agent 1's API is absent. */
  function levelsArray() {
    if (!SM.adv || typeof SM.adv.getLevels !== 'function') return null;
    var ls = null;
    try { ls = SM.adv.getLevels(); } catch (e) { ls = null; }
    if (!ls || typeof ls.length !== 'number') return null;
    return ls;
  }

  /**
   * A cheap integer signature of WHICH levels are owned. No allocation and no
   * strings: this runs on a poll, and the answer is nearly always "unchanged".
   * -1 means "there is no levels API", which is itself a state worth detecting.
   */
  function levelsSig() {
    var ls = levelsArray();
    if (!ls) return -1;
    var s = ls.length | 0;
    for (var i = 0; i < ls.length; i++) {
      var L = ls[i];
      if (!L || !L.owned) continue;
      s = (Math.imul(s, 33) + (((L.i | 0) * 1013) ^ (Math.round(num(L.depthM, 0)) | 0))) | 0;
    }
    return s;
  }

  /** Insert one owned station, keeping the arrays sorted shallowest first. */
  function insertStation(y, depthM, level, name) {
    if (stN >= STATION_MAX) return;
    var k = stN;
    while (k > 0 && stY[k - 1] > y) {
      stY[k] = stY[k - 1]; stDepthM[k] = stDepthM[k - 1];
      stLevel[k] = stLevel[k - 1]; stArt[k] = stArt[k - 1];
      k--;
    }
    stY[k] = y; stDepthM[k] = depthM; stLevel[k] = level;
    stArt[k] = readoutFor(level, depthM, name, true);
    stN++;
  }

  /**
   * Re-read the level table and rebuild everything derived from it.
   *
   * Cheap enough to call on an event and idempotent enough to call on a poll.
   * The readout panels come out of a cache keyed by what is printed on them, so
   * buying the fourth level does not re-bake the first three.
   */
  function resolveLevels() {
    stN = 0;
    liftApi = false;
    nextOn = false;
    nextArt = null;
    liftReach = 0;
    // With no station owned there is no shaft; the mouth chamber's own floor
    // stands in as "how far down the lift reaches" for the tests below.
    shaftBotY = A.MINE_CEILING_Y + MOUTH_CY + MOUTH_R * 0.74;
    liftSig = levelsSig();

    var ls = levelsArray();
    if (!ls) return;
    liftApi = true;

    /* A station may not punch into the bedrock floor: the bottom of a mine is
     * expressed as hardness, and a lift landing carved through it would be a
     * hole in the one thing that is not supposed to have holes in it. */
    var botLimit = floorY - STATION_RY - SP;
    var topLimit = A.MINE_CEILING_Y + MOUTH_R;
    var i, L, y;

    for (i = 0; i < ls.length; i++) {
      L = ls[i];
      if (!L || !L.owned) continue;
      if ((L.i | 0) <= 0) continue;                 // i = 0 is the surface
      y = num(L.y, NaN);
      if (!(y === y)) y = yOfDepth(num(L.depthM, 0));
      if (!(y > topLimit) || y > botLimit) continue;
      insertStation(y, num(L.depthM, depthOfY(y)), L.i | 0, L.name || '');
    }

    if (stN) {
      shaftBotY = stY[stN - 1] + STATION_RY + SHAFT_SUMP;
      if (shaftBotY > floorY - SP) shaftBotY = floorY - SP;
      /* The reject box, in world x. West of the column only the lining is
       * excavated; east of it the station rooms are. */
      liftReach = 1;
      liftXLo = ELEV_X - (SHAFT_HALF > STATION_BACK ? SHAFT_HALF : STATION_BACK) - 2;
      liftXHi = ELEV_X + (SHAFT_HALF > STATION_FWD ? SHAFT_HALF : STATION_FWD) + 2;
    }

    /* THE NEXT LEVEL DOWN, unowned: the shallowest one below what the shaft
     * already reaches. Drawn as a closed continuation (see drawHint) so "there
     * is more down there, and it is for sale" is a thing the WORLD says, not
     * only a row in a menu.
     *
     * Only when at least one station is owned, because the hint is drawn in the
     * SUMP and there is no sump until there is a shaft. Before the first
     * purchase the boards would be painted behind solid rock, and the "there is
     * more to buy" job belongs to the UI at that point anyway. */
    if (!stN) return;
    for (i = 0; i < ls.length; i++) {
      L = ls[i];
      if (!L || L.owned || (L.i | 0) <= 0) continue;
      y = num(L.y, NaN);
      if (!(y === y)) y = yOfDepth(num(L.depthM, 0));
      if (!(y > shaftBotY)) continue;
      if (nextOn && y >= nextY) continue;
      nextOn = true;
      nextY = y;
      nextArt = readoutFor(L.i | 0, num(L.depthM, depthOfY(y)), L.name || '', false);
    }
  }

  /**
   * True where the lift's own excavation has removed the rock. Kept as one
   * function so the generator, the scanner and the renderer cannot disagree
   * about where the shaft is — the same argument driftOfCell() makes.
   */
  function inLiftVoid(x, y) {
    if (!liftReach) return false;
    if (x < liftXLo || x > liftXHi) return false;
    var lx = x - ELEV_X;                       // shaft-local x; +lx is EAST
    if (y < shaftBotY && lx > -SHAFT_HALF && lx < SHAFT_HALF) return true;
    for (var i = 0; i < stN; i++) {
      var dy = (y - stY[i]) / STATION_RY;
      if (dy < -1 || dy > 1) continue;
      // The ROOM: |dx|^4 + |dy|^4 < 1, with a DIFFERENT half-extent each side of
      // the column, because a landing at the mine's edge opens one way only.
      var dx = lx / (lx < 0 ? STATION_BACK : STATION_FWD);
      // Squaring twice keeps the fourth power to multiplies.
      dx *= dx; dy *= dy;
      if (dx * dx + dy * dy < 1) return true;
    }
    return false;
  }

  /**
   * A LEVEL WAS BOUGHT WHILE ITS BAND IS ALREADY RESIDENT.
   *
   * THE WHOLE RESIDENT WINDOW, NOT A PATCH. The window is a rectangle of
   * GENERATED cells and generation is what decides where the shaft is, so the
   * honest way to re-open a band that was filled under the old ownership is to
   * throw the resident set away and re-run the fill under the new one:
   * flushAll() frees every particle (and un-flags the dumped heaps, so they come
   * straight back), then the one-shot streamPass refills exactly what the camera
   * wants. Patching only the shaft's own columns would mean despawning a
   * sub-rectangle, and particles.js frees OUTSIDE a rect and not inside one — a
   * partial cut is precisely the double-density bug the header warns about.
   *
   * It costs one full fill in the frame the player pressed BUY, which is a frame
   * they are looking at a menu in. Entering a mine already does the same thing.
   */
  function reopenLift() {
    if (!active || !haveN) return;
    flushAll();
    streamPass(1e9);
    spawnReadyPiles();
    SM.particles.rebuildGrid();
  }

  function onLiftBought() {
    if (!loaded) return;
    resolveLevels();
    reopenLift();
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
   * `centred` is the guaranteed lode: it is placed near the MINE'S centre line
   * rather than anywhere across the width (see LODE_GUARANTEED_X), because it is
   * the payoff for DEPTH. That line is x = 0 and is independent of ELEV_X — see
   * the note on LODE_GUARANTEED_X for why moving it with the elevator would have
   * been a regeneration of every seed rather than a relocation.
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
    dx = px - (ELEV_X + MOUTH_DX); dy = py - (A.MINE_CEILING_Y + MOUTH_CY);
    if (dx * dx + dy * dy < MOUTH_R * MOUTH_R) return -1;

    /* --- the floor of the mine --------------------------------------- */
    if (py > floorY) {
      // A ragged top surface so the floor does not read as a drawn line.
      if (py < floorY + SP * 1.5 && hv(S_FLOOR, cx, cy) < 0.35) return M_GRANITE;
      return M_BEDROCK;
    }

    /* --- THE LIFT: the shaft column and the station chambers ----------
     * Deliberately BELOW the floor test — bedrock wins, always — and above the
     * blobs, because the shaft was cut through whatever was in the way and a
     * cavern's ore shell crossing it was taken out a long time ago.
     *
     * Cheap on the hot path, which matters: this function runs once per cell.
     * `liftReach` is 0 until a station is actually owned, and past that the
     * x-range compare inlined here rejects every cell in a 5200-unit-wide mine
     * that is nowhere near the shaft — which is 95% of them. Only the survivors
     * pay for the call, and the call is shared with the scanner and the renderer
     * so the three can never disagree about where the shaft is.
     * ---------------------------------------------------------------- */
    if (liftReach && px > liftXLo && px < liftXHi && inLiftVoid(px, py)) return -1;

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

    /* THE HASH CLAMP CAN CUT INSIDE THE WINDOW, AND IT HAS TO CUT ON CELL EDGES.
     *
     * Normally this clamp sits well outside the solid window and only bounds
     * stray debris. But the window is SIZED from the camera and PLACED around the
     * streaming focus, so when the two diverge the bias (up to WINDOW_BIAS of the
     * half-extent) can push the window's far edge more than WIN_MAX_W/2 from the
     * focus and the clamp lands INSIDE it. That is not exotic: drive to the far
     * wall of a 5200-wide mine and camera.js stops panning (ADV_WALL_PEEK) while
     * the machine keeps going, which is exactly that divergence. Measured, with a
     * scripted focus 2600 units from the camera, a returning window came back at
     * 1837 of 5106 solids and stayed there.
     *
     * Two things were wrong and both are fixed here. The cut was at an arbitrary
     * x, which splits a column and leaves half a strip alive — the double-density
     * hazard the header warns about — so it is snapped to the cell lattice. And
     * the emptied strips still counted as RESIDENT, so the fill loop never
     * regenerated them: a hole in the ground the streamer believed it had filled,
     * permanent until the window jumped clear and re-filled from scratch. Folding
     * the clamp into the resident rectangle is what makes it heal. */
    if (kL < mx - hx) kL = colEdgeX(Math.ceil((mx - hx - x0) / SP));
    if (kR > mx + hx) kR = colEdgeX(Math.floor((mx + hx - x0) / SP));
    if (kT < my - hy) kT = rowTopY(Math.ceil((my - hy - y0) / SP));
    if (kB > my + hy) kB = rowTopY(Math.floor((my + hy - y0) / SP));
    SM.particles.despawnOutsideRect(kL, kT, kR, kB, false);

    if (haveC0 < c0) haveC0 = c0;
    if (haveC1 > c1) haveC1 = c1;
    if (haveR0 < r0) haveR0 = r0;
    if (haveR1 > r1) haveR1 = r1;
    /* Whatever the clamp emptied is not resident any more. In the ordinary case
     * these four are no-ops — the keep rect is LOOSE_KEEP_PAD outside the window,
     * so its cell range is strictly wider than the resident one. */
    var kc0 = colOfX(kL), kc1 = colOfX(kR);
    var kr0 = cellYOf(kT), kr1 = cellYOf(kB);
    if (haveC0 < kc0) haveC0 = kc0;
    if (haveC1 > kc1) haveC1 = kc1;
    if (haveR0 < kr0) haveR0 = kr0;
    if (haveR1 > kr1) haveR1 = kr1;
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
    // BEFORE the first fill: the shaft and the stations are part of the geology
    // this mine generates, not something painted on afterwards.
    liftTick = 0;
    resolveLevels();

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
    // The lift belongs to the mine, not to the session. endMine() deliberately
    // keeps it (the world still renders behind the results card); this is the
    // other half, and it must leave liftReach at 0 so nothing carves.
    stN = 0;
    liftApi = false;
    liftReach = 0;
    nextOn = false;
    nextArt = null;
    liftSig = -2;
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
    /* THE OWNERSHIP POLL. `lift:bought` is the fast path; this is the one that
     * cannot be forgotten. It is an integer compare over a handful of levels,
     * eight times a second, and it runs BEFORE streamPass() so the strip filled
     * this very step already has the new shaft in it. */
    if (++liftTick >= LIFT_POLL) {
      liftTick = 0;
      if (levelsSig() !== liftSig) { resolveLevels(); reopenLift(); }
    }
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
    /* A newly bought station must open WITHOUT a page reload. js/adv.js emits
     * this the moment the purchase clears; update()'s poll is the backstop. */
    SM.events.on('lift:bought', onLiftBought);
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
    // A formation the player has already mined out should stop answering — and
    // so should one the lift's own excavation removed, or the scanner would
    // point an arrow at ore that is standing in the middle of the shaft.
    if (isCarved(x, y)) return;
    if (inLiftVoid(x, y)) return;
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

  /* --- worklights at the mine mouth (drawWorkLights) ------------------- */
  var FESTOON_N = 7;           // bulbs strung down EACH wall of the shaft head
  var FESTOON_GAP = 34;        // world units between bulbs
  /* WHERE THE STRINGS HANG, and it is the SHAFT's walls, not the headframe's
   * brackets. They used to hang off the portal frame at hx + 9, which is 193
   * units out — fine over a mouth in the middle of a mine, and 43 units of solid
   * rock west of the excavation once the mouth is at the west wall (screenshotted:
   * a column of bulbs embedded in the rind). Hung off the shaft's own lining they
   * are both inside the void at every depth they reach AND doing the job the
   * comment below claims for them: they light the top of the SHAFT, which is what
   * you look up at on the way out. */
  var FESTOON_X = 159;         // = SHAFT_HALF + 9; change the two together
  var lampPhase = 0;           // monotonic; drives a deterministic flicker
  var lampGrads = {};          // radius+colour -> cached radial gradient

  var rockPattern = null, wallPattern = null;
  var tileSeed = 0;
  /* The BASE COLOUR of wallPattern, i.e. the rock cap and the bedrock walls. Must
   * match buildTiles()'s noiseTile(58, 53, 62, ...) call — drawMouth() grades the
   * daylight into this flat colour because a pattern cannot be alpha-ramped. */
  var CAP_RGB = '58,53,62';

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

  /**
   * DAYLIGHT AND THE ELEVATOR HEAD, at the mine's WEST CORNER.
   *
   * Two separate jobs that used to be one. The sky is a PATCH over the head that
   * grades east into the rock cap render() has already painted (see DAY_HALF): the
   * workings run 4800 units east of here and their roof is rock, so a bright band
   * across the whole ceiling would say the exact opposite of the truth and would
   * also spend the one strong visual cue this mode has — "that way is out" — on
   * every metre of it equally. The headframe, the floods and the festoons then
   * draw over the column itself, in ELEV_X-local coordinates.
   */
  function drawMouth(ctx, v, vTop) {
    var ceil = A.MINE_CEILING_Y;
    if (vTop > ceil) return;
    var top = ceil - SKY_DEPTH;

    /* --- the daylight patch ------------------------------------------- */
    var xW = v.minX - 60;
    var xE = ELEV_X + DAY_HALF;
    if (xE > xW) {
      /* Daylight over a FIXED distance, not over the visible slice. Anchoring the
       * bright end to vTop meant that on the framing the camera actually uses at
       * the mouth (camera.js caps the sky at ADV_SKY_PEEK) only the dark end of
       * the ramp was ever on screen, and the surface read as more rock. */
      var flat = vTop < top;
      var g = ctx.createLinearGradient(0, top, 0, ceil);
      g.addColorStop(0, '#8194ab');
      g.addColorStop(0.45, '#4d5464');
      g.addColorStop(1, '#14131a');

      /* THE GRADE INTO THE ROCK CAP, IN TWO RECTS AND NO BANDING.
       *
       * The cap is a repeating PATTERN and a pattern cannot carry an alpha ramp,
       * so the first attempt re-drew the sky over it in strips of falling alpha.
       * Screenshotted: eight legible vertical bars, and raising the count to 24
       * traded them for 24 fainter ones plus a hairline at every overlap where two
       * alphas double-composited. Strips are simply the wrong tool.
       *
       * So the sky is painted across the WHOLE span including the grade, and the
       * grade is then a single HORIZONTAL gradient of the cap's own base colour
       * over the top of it: rgba(CAP,0) at the daylight end, rgba(CAP,1) at the
       * rock end. Both gradients are continuous, so there is nothing to band. The
       * only seam left is a TEXTURE one at the grade's east edge, where flat cap
       * colour meets patterned cap colour — the same colour, differing by the
       * pattern's own +-24 speckle, which is invisible next to a full-screen
       * multiply-towards-black. */
      var xF = xE + DAY_FADE;
      if (xF > v.maxX + 60) xF = v.maxX + 60;
      if (xF > xW) {
        if (flat) {
          ctx.fillStyle = '#8194ab';
          ctx.fillRect(xW, vTop - 60, xF - xW, top - vTop + 60);
        }
        ctx.fillStyle = g;
        ctx.fillRect(xW, top, xF - xW, ceil - top);
      }
      if (xF > xE) {
        var cg = ctx.createLinearGradient(xE, 0, xE + DAY_FADE, 0);
        cg.addColorStop(0, 'rgba(' + CAP_RGB + ',0)');
        cg.addColorStop(1, 'rgba(' + CAP_RGB + ',1)');
        ctx.fillStyle = cg;
        ctx.fillRect(xE, vTop - 60, xF - xE, ceil - vTop + 60);
      }
    }

    /* --- the head itself, over the column ----------------------------- */
    if (v.maxX < ELEV_X - PORTAL_W || v.minX > ELEV_X + PORTAL_W) return;
    ctx.save();
    ctx.translate(ELEV_X, 0);

    // The portal frame, spanning the shaft head.
    var w = PORTAL_W;
    ctx.fillStyle = '#5a3d24';
    ctx.fillRect(-w * 0.5 - 14, ceil - 18, w + 28, 22);
    ctx.fillRect(-w * 0.5 - 14, ceil - 4, 18, 90);
    ctx.fillRect(w * 0.5 - 4, ceil - 4, 18, 90);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-w * 0.5, ceil + 4, w, 12);

    drawWorkLights(ctx, ceil, w);
    ctx.restore();
  }

  /**
   * WORKLIGHTS ON THE PORTAL — the surface is a WORKSITE.
   *
   * Two things this buys beyond decoration. It marks where the exit is from
   * further away than the timbers do, because a warm lens against brown wood on
   * brown rock still reads once the darkness composite has flattened both. And it
   * makes the mouth read as somewhere people work, which is the contrast the whole
   * descent depends on: lit and busy up here, unlit and alone down there.
   *
   * NOTE that this is the GEOMETRY pass, so none of it survives the composite past
   * the headlight — carrying the exit from further out than that is DAY_GLOW_R's
   * job, in renderLit(). These lamps are the close-range read.
   *
   * Lamps on the headframe, plus a run of festoon bulbs strung down each side
   * wall that dim as they go — the last thing you see on the way down and the
   * first thing you see coming back.
   *
   * Cheap on purpose: one radial gradient per distinct radius, cached, and no
   * gradient at all for the small strung bulbs. Only drawn when the mouth is
   * genuinely on screen, because drawMouth() returns early otherwise.
   */
  function drawWorkLights(ctx, ceil, w) {
    var hx = w * 0.5;

    /* The flicker is a sum of two sines, NOT a random walk: it has to be a pure
     * function of a monotonic phase so the lamps do not jump when the band
     * streams out and back in. */
    lampPhase += 0.016;
    var flick = 0.90 + 0.10 * Math.sin(lampPhase * 2.3) * Math.sin(lampPhase * 0.7 + 1.1);

    // --- two headframe floods, on brackets over the portal ---
    var i, lx;
    for (i = -1; i <= 1; i += 2) {
      lx = i * (hx + 6);
      ctx.fillStyle = '#3b3f47';
      ctx.fillRect(lx - 7, ceil - 34, 14, 9);           // housing
      ctx.fillStyle = 'rgba(24,26,30,0.9)';
      ctx.fillRect(lx - 2, ceil - 26, 4, 10);           // stalk
      lampGlow(ctx, lx, ceil - 27, 116, 'rgba(255,214,138,', 0.52 * flick);
      ctx.fillStyle = 'rgba(255,236,190,' + (0.95 * flick).toFixed(3) + ')';
      ctx.fillRect(lx - 5, ceil - 32, 10, 5);           // the lit lens
    }

    /* --- festoon bulbs down both walls OF THE SHAFT -------------------
     * They fade with depth so the string reads as leaving the daylight behind,
     * and there are only FESTOON_N of them so they never march past the mouth
     * chamber into ground the player still has to dig. See FESTOON_X for why they
     * hang off the shaft's lining rather than off the headframe's brackets. */
    for (i = 0; i < FESTOON_N; i++) {
      var y = ceil + 26 + i * FESTOON_GAP;
      var dim = 1 - (i / FESTOON_N) * 0.72;
      var a = 0.85 * dim * flick;
      for (var s = -1; s <= 1; s += 2) {
        var bx = s * FESTOON_X;
        ctx.strokeStyle = 'rgba(18,16,14,0.75)';        // the sagging cable
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(bx, y - FESTOON_GAP);
        ctx.quadraticCurveTo(bx + s * 5, y - FESTOON_GAP * 0.5, bx, y);
        ctx.stroke();
        lampGlow(ctx, bx, y, 52, 'rgba(255,196,110,', 0.34 * dim * flick);
        ctx.fillStyle = 'rgba(255,228,168,' + a.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(bx, y, 3.1, 0, 6.2831853);
        ctx.fill();
      }
    }
  }

  /**
   * One cached radial glow, keyed by colour and ROUNDED radius. Building a
   * gradient per lamp per frame is exactly the kind of allocation that turns a
   * decoration into a frame-rate problem, and there are only two distinct radii.
   */
  function lampGlow(ctx, x, y, r, rgbPrefix, alpha) {
    if (!(r > 1) || alpha <= 0.004) return;
    var key = rgbPrefix + Math.round(r);
    var g = lampGrads[key];
    if (!g) {
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, rgbPrefix + '0.85)');
      g.addColorStop(0.45, rgbPrefix + '0.30)');
      g.addColorStop(1, rgbPrefix + '0)');
      lampGrads[key] = g;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }

  /* ======================================================================
   * THE LIFT, DRAWN
   *
   * Three pieces, in the order the eye finds them: the lined shaft you came
   * down, the station chamber you are standing in, and the BIG RED DEPTH
   * READOUT that tells you which one it is.
   * =================================================================== */

  /* --- the depth readout ----------------------------------------------
   * The one thing a lift must tell you is WHERE YOU ARE, and it is asked for in
   * big red LED figures. Seven-segment geometry rather than a font, for two
   * reasons: it reads as an instrument at any size (a 390-wide phone shows this
   * at ~27 px of digit height, a desktop at ~45), and the DARK segments of every
   * digit are half of what makes an LED panel look like an LED panel at all.
   *
   * PRE-RENDERED ONCE PER STATION INTO AN OFFSCREEN CANVAS. A station's depth
   * never changes, so laying out segments, measuring text and baking the bloom
   * per frame would be paying every frame for a picture that is identical every
   * time. Per frame it is one drawImage and one CACHED radial glow — the same
   * discipline as drawWorkLights, and for the same reason.
   * ------------------------------------------------------------------ */
  var LED_SS = 2;              // supersample of the offscreen art: crisp up to
                               // a 2x camera scale, and nothing shows above 1.
  /* Sized so the widest board in the catalogue (a four-figure depth, "-3 000 m")
   * comes out at 252 world units and still hangs inside the 300-unit shaft. At
   * the camera scales this mode actually uses that is 42 px of digit height on a
   * desktop and 26 on a 390-wide phone. */
  var LED_DW = 30, LED_DH = 52;         // one digit cell
  var LED_T = 9;                        // segment thickness
  var LED_GAP = 6, LED_SPACE = 15;      // between digits / the thousands gap
  var LED_PAD = 15, LED_TAG = 14, LED_LVL = 25;

  /* Segment rectangles of one digit cell, in the order a b c d e f g. A flat
   * table rather than seven branches: the panel is baked once, so what matters
   * is that the geometry is readable in one place. */
  var LED_HB = LED_DW - LED_T * 1.24;         // horizontal bar length
  var LED_VB = LED_DH * 0.5 - LED_T * 1.06;   // vertical bar length
  var SEGX = [LED_T * 0.62, LED_DW - LED_T, LED_DW - LED_T, LED_T * 0.62,
              0, 0, LED_T * 0.62];
  var SEGY = [0, LED_T * 0.62, LED_DH * 0.5 + LED_T * 0.44, LED_DH - LED_T,
              LED_DH * 0.5 + LED_T * 0.44, LED_T * 0.62, LED_DH * 0.5 - LED_T * 0.5];
  var SEGW = [LED_HB, LED_T, LED_T, LED_HB, LED_T, LED_T, LED_HB];
  var SEGH = [LED_T, LED_VB, LED_VB, LED_T, LED_VB, LED_VB, LED_T];
  var SEG_ON = ['1111110', '0110000', '1101101', '1111001', '0110011',
                '1011011', '1011111', '1110000', '1111111', '1111011'];
  var SEG_MINUS = '0000001';

  var artCache = {};           // what is printed on it -> baked panel
  var measCtx = null;          // one scratch context for measureText

  /** 2100 -> "-2 100". The thousands gap is a real gap in the segment layout. */
  function ledFigures(depthM) {
    var n = Math.round(depthM);
    if (n < 0) n = 0;
    var s = '' + n;
    var out = '-';
    for (var i = 0; i < s.length; i++) {
      if (i > 0 && ((s.length - i) % 3) === 0) out += ' ';
      out += s.charAt(i);
    }
    return out;
  }

  function measureWith(font, text) {
    if (!measCtx) measCtx = document.createElement('canvas').getContext('2d');
    measCtx.font = font;
    return measCtx.measureText(text).width;
  }

  function drawGlyph(g, x, y, bits, lit) {
    var k;
    /* A DEAD BOARD SHOWS ITS NUMBER FAINTLY AND NOTHING ELSE. Drawing the full
     * ghost field is what an unpowered LED genuinely looks like, and it reads as
     * "-888 m" because every digit becomes an 8 — measured by looking at a
     * screenshot of exactly that. Legible beats literal. */
    if (!lit) {
      g.fillStyle = 'rgba(158,62,50,0.40)';
      for (k = 0; k < 7; k++) {
        if (bits.charAt(k) !== '1') continue;
        g.fillRect(x + SEGX[k], y + SEGY[k], SEGW[k], SEGH[k]);
      }
      return;
    }

    /* The dark segments first: an LED display is a grid of segments that are OFF
     * with a few switched on, and drawing only the lit ones reads as paint
     * rather than as a lamp.
     *
     * EXCEPT ON THE MINUS, where a full ghost field around one lit middle bar
     * does not read as a minus sign — it reads as a broken digit, and the board
     * said "8135" instead of "-135". */
    if (bits !== SEG_MINUS) {
      g.fillStyle = 'rgba(122,26,18,0.5)';
      for (k = 0; k < 7; k++) g.fillRect(x + SEGX[k], y + SEGY[k], SEGW[k], SEGH[k]);
    }
    g.shadowColor = 'rgba(255,64,38,0.95)';
    g.shadowBlur = 15;
    g.fillStyle = '#ff2f1c';
    for (k = 0; k < 7; k++) {
      if (bits.charAt(k) !== '1') continue;
      g.fillRect(x + SEGX[k], y + SEGY[k], SEGW[k], SEGH[k]);
    }
    g.shadowBlur = 0;
    /* A hot core inside each lit bar, so the figures read as emitting rather
     * than as red-painted metal once the darkness composite lands on them.
     *
     * IT IS THE ONLY BRIGHTNESS THAT SURVIVES A DIM LAMP. Past the light radius
     * the composite multiplies everything here by 0.06, so what the player
     * actually sees is this core and nothing else — which is why it is nearly
     * white rather than red, and why it is worth the two extra fillRects. Baked,
     * so it costs nothing per frame. */
    g.fillStyle = 'rgba(255,201,182,0.58)';
    for (k = 0; k < 7; k++) {
      if (bits.charAt(k) !== '1') continue;
      g.fillRect(x + SEGX[k] + 2.4, y + SEGY[k] + 2.4,
                 SEGW[k] - 4.8, SEGH[k] - 4.8);
    }
  }

  /**
   * Bake one panel. `lit` false is the same sign switched OFF, which is what the
   * unowned level below the last station gets — the display being dark is the
   * cheapest possible way to say "not yours yet".
   */
  function buildReadout(level, depthM, name, lit) {
    var figs = ledFigures(depthM);
    var i, ch;

    var digitsW = 0;
    for (i = 0; i < figs.length; i++) {
      ch = figs.charAt(i);
      digitsW += (ch === ' ') ? LED_SPACE : (LED_DW + LED_GAP);
    }
    digitsW -= LED_GAP;

    var unitFont = 'bold ' + Math.round(LED_DH * 0.52) +
                   'px ui-sans-serif, system-ui, Arial, sans-serif';
    var unitW = measureWith(unitFont, 'm') + 11;

    /* THE LEVEL NUMBER IS ITS OWN SIZE. One monospace row of everything put the
     * level number at 14 world units, which is 7 px on a 390-wide phone —
     * present, unreadable, and therefore pointless. The number is the second
     * thing the player wants after the depth, so it gets its own weight and the
     * stratum name stays small beside it. */
    var lvl = 'L' + level;
    var nm = name ? ('' + name).toUpperCase() : '';
    if (nm.length > 15) nm = nm.substr(0, 15);
    if (!lit) nm = nm ? (nm + '  LOCKED') : 'LOCKED';
    var lvlFont = 'bold ' + LED_LVL + 'px ui-sans-serif, system-ui, Arial, sans-serif';
    var tagFont = 'bold ' + LED_TAG + 'px ui-monospace, Menlo, Consolas, monospace';
    var tagW = measureWith(lvlFont, lvl) + 8 + measureWith(tagFont, nm);

    var inner = digitsW + unitW;
    if (tagW > inner) inner = tagW;
    var w = Math.ceil(inner + LED_PAD * 2);
    var h = Math.ceil(LED_DH + LED_LVL + 8 + LED_PAD * 2);

    var cv = document.createElement('canvas');
    cv.width = Math.ceil(w * LED_SS);
    cv.height = Math.ceil(h * LED_SS);
    var g = cv.getContext('2d');
    g.scale(LED_SS, LED_SS);

    // Bezel, then the screen inside it.
    g.fillStyle = lit ? '#2a1a1a' : '#1d1717';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(0, 0, w, 2);
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.fillRect(0, h - 3, w, 3);
    g.fillStyle = lit ? '#0b0506' : '#0a0809';
    g.fillRect(4, 4, w - 8, h - 8);

    var dy = LED_PAD + LED_LVL + 8;
    if (lit) {
      // The bloom the panel throws onto its own bezel. Baked, so it is free.
      var bx = w * 0.5, by = dy + LED_DH * 0.5;
      var rr = Math.max(w, h) * 0.72;
      var bg = g.createRadialGradient(bx, by, 0, bx, by, rr);
      bg.addColorStop(0, 'rgba(255,72,44,0.40)');
      bg.addColorStop(0.55, 'rgba(255,50,28,0.14)');
      bg.addColorStop(1, 'rgba(255,40,20,0)');
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
    }

    // The level number and the stratum, on their own row above the figures.
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.font = lvlFont;
    g.fillStyle = lit ? 'rgba(255,170,140,0.95)' : 'rgba(178,100,86,0.62)';
    g.fillText(lvl, LED_PAD, LED_PAD - 1);
    var lvlW = measureWith(lvlFont, lvl);
    g.font = tagFont;
    g.fillStyle = lit ? 'rgba(226,138,112,0.82)' : 'rgba(150,84,74,0.55)';
    g.fillText(nm, LED_PAD + lvlW + 8, LED_PAD + (LED_LVL - LED_TAG) * 0.72);

    // The figures, right-aligned against the unit so panels of different depths
    // still line their "m" up with each other.
    var x = w - LED_PAD - unitW - digitsW;
    for (i = 0; i < figs.length; i++) {
      ch = figs.charAt(i);
      if (ch === ' ') { x += LED_SPACE; continue; }
      drawGlyph(g, x, dy, ch === '-' ? SEG_MINUS : SEG_ON[+ch], lit);
      x += LED_DW + LED_GAP;
    }

    g.font = unitFont;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = lit ? '#ff6f52' : 'rgba(150,74,64,0.6)';
    g.fillText('m', x + 4, dy + LED_DH);

    return { cv: cv, w: w, h: h };
  }

  /**
   * Cached by exactly what is printed on it, so buying the fourth level re-bakes
   * one panel and not four.
   *
   * The cache is CAPPED, because it outlives a mine: one board is about 400 KB of
   * canvas at LED_SS, and a session that visits every mine in the catalogue and
   * buys down each of them would otherwise accumulate tens of megabytes of
   * pictures of numbers. Re-baking an evicted board costs well under a
   * millisecond and only happens when the level table is re-resolved.
   */
  var LED_CACHE_MAX = 14;
  var artKeys = [];

  function readoutFor(level, depthM, name, lit) {
    var key = level + '|' + Math.round(depthM) + '|' + (lit ? 1 : 0) + '|' + name;
    var a = artCache[key];
    if (a) return a;
    a = buildReadout(level, depthM, name, lit);
    artCache[key] = a;
    artKeys.push(key);
    while (artKeys.length > LED_CACHE_MAX) delete artCache[artKeys.shift()];
    return a;
  }

  /**
   * THE SHAFT, LINED. The column is carved by the generator, so what is left to
   * draw is the infrastructure in it: a dark excavated column, wall timbers, a
   * timber set every SHAFT_SET_PITCH, the two guide rails the cage runs on and
   * the hoist ropes. The pitch is anchored to the WORLD, not to the view, so the
   * sets do not crawl up the screen as the camera moves.
   */
  function drawShaft(ctx, vTop, vBot) {
    if (!stN) return;
    var a = vTop > A.MINE_CEILING_Y ? vTop : A.MINE_CEILING_Y;
    var b = vBot < shaftBotY ? vBot : shaftBotY;
    if (b <= a) return;

    ctx.fillStyle = 'rgba(10,9,11,0.62)';
    ctx.fillRect(-SHAFT_HALF, a, SHAFT_HALF * 2, b - a);

    // Wall lining: sawn timber down both sides, with the rock's shadow on it.
    ctx.fillStyle = 'rgba(84,57,34,0.9)';
    ctx.fillRect(-SHAFT_HALF, a, 8, b - a);
    ctx.fillRect(SHAFT_HALF - 8, a, 8, b - a);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(-SHAFT_HALF + 8, a, 5, b - a);
    ctx.fillRect(SHAFT_HALF - 13, a, 5, b - a);

    // Timber sets, on the world pitch. At most ~12 of these are ever on screen.
    var y = Math.floor(a / SHAFT_SET_PITCH) * SHAFT_SET_PITCH;
    for (; y < b; y += SHAFT_SET_PITCH) {
      if (y < a) continue;
      ctx.fillStyle = 'rgba(96,66,40,0.72)';
      ctx.fillRect(-SHAFT_HALF, y, SHAFT_HALF * 2, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(-SHAFT_HALF, y + 5, SHAFT_HALF * 2, 3);
    }

    // The guide rails and the hoist ropes: the cage runs on these, so they are
    // what makes the column read as a lift and not as a hole.
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(154,164,180,0.42)';
    ctx.beginPath();
    ctx.moveTo(-SHAFT_HALF + 30, a); ctx.lineTo(-SHAFT_HALF + 30, b);
    ctx.moveTo(SHAFT_HALF - 30, a); ctx.lineTo(SHAFT_HALF - 30, b);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(206,212,224,0.3)';
    ctx.beginPath();
    ctx.moveTo(-15, a); ctx.lineTo(-15, b);
    ctx.moveTo(15, a); ctx.lineTo(15, b);
    ctx.stroke();
  }

  /**
   * ONE STATION: the chamber, the platform, two worklights, the cage, and the
   * readout above it. A smaller sibling of the mouth chamber on purpose — the
   * mouth is where the mode's contrast starts (lit and busy up there, unlit and
   * alone down here), and a station is that same worksite, further down and with
   * less of it.
   *
   * ALL COORDINATES ARE SHAFT-LOCAL: drawLift() has translated the context to
   * ELEV_X, so 0 is the column's centreline and +x is EAST, into the room.
   */
  function drawStation(ctx, i, flick) {
    var cy = stY[i];
    // The platform IS the floor of the room. Higher up it reads as a shelf the
    // machine's drill hangs through, because the machine is 340 units long and
    // the deck is only drawn — nothing collides with it.
    var deck = cy + STATION_RY * 0.84;

    /* The excavated room. A rounded rectangle drawn a little INSIDE the carved
     * superellipse: the deposits at the edge are what the eye reads as the wall,
     * so this only has to darken the void, and painting past it would put a
     * black corner on solid rock — and at the mine's west edge that rock is the
     * bedrock the world ends at, so the inset on THAT side matters most. */
    /* The west inset is only 8, not 18: the headframe's own post stands at -174
     * and a room wall painted at -172 would have cut it in half. */
    roomPath(ctx, -STATION_BACK + 8, STATION_FWD - 18, cy, STATION_RY - 22, 80);
    ctx.fillStyle = 'rgba(13,11,12,0.66)';
    ctx.fill();

    // The shaft frame standing in the chamber: two posts and a cap beam.
    var fTop = cy - STATION_RY * 0.80;
    ctx.fillStyle = '#5a3d24';
    ctx.fillRect(-SHAFT_HALF - 24, fTop, 13, deck - fTop);
    ctx.fillRect(SHAFT_HALF + 11, fTop, 13, deck - fTop);
    ctx.fillRect(-SHAFT_HALF - 30, fTop - 13, (SHAFT_HALF + 30) * 2, 15);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(-SHAFT_HALF - 30, fTop + 2, (SHAFT_HALF + 30) * 2, 5);

    /* The platform: planked decks with the SHAFT OPENING between them. The
     * opening is the point — a landing whose floor runs straight across the
     * shaft is not a landing on a shaft, it is a shelf, and it would also hide
     * the boarded continuation that tells the player there is more to buy.
     *
     * The WEST segment is now a ledge against the back wall rather than half the
     * platform, so it comes out a few units wide or nothing at all; the `xB <=
     * xA` guard is what makes that a no-op instead of a negative-width fill. All
     * of the deck the player actually drives on runs east. */
    var oL = -SHAFT_HALF - 14, oR = SHAFT_HALF + 14;
    var pk, seg;
    for (seg = 0; seg < 2; seg++) {
      var xA = seg ? oR : -STATION_BACK + 12;
      var xB = seg ? STATION_FWD - 26 : oL;
      if (xB <= xA) continue;
      ctx.fillStyle = 'rgba(102,71,43,0.95)';
      ctx.fillRect(xA, deck, xB - xA, 11);
      ctx.fillStyle = 'rgba(0,0,0,0.34)';
      for (pk = 1; pk < 4; pk++) ctx.fillRect(xA + (xB - xA) * pk / 4 - 1, deck, 2, 11);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(xA, deck + 11, xB - xA, 8);
      ctx.fillStyle = 'rgba(74,50,30,0.9)';
      ctx.fillRect((xA + xB) * 0.5 - 5, deck + 11, 10, 28);
      ctx.fillRect(xA + 8, deck + 11, 10, 28);
    }
    // The edge of the opening, kerbed: the one place on the platform you could
    // fall down a shaft.
    ctx.fillStyle = 'rgba(196,150,60,0.75)';
    ctx.fillRect(oL - 4, deck - 4, 12, 6);
    ctx.fillRect(oR - 8, deck - 4, 12, 6);

    /* --- the cage -----------------------------------------------------
     * On the shaft centreline, standing on the deck, and sized to LOOK like it
     * could hold the machine — because it does: riding the lift is the machine
     * going up in this. Drawn behind the hull (terrain renders before particles
     * and the vehicle), so a machine parked at the station reads as being inside
     * it and a machine that has driven off onto the platform leaves it empty. */
    var cw = 210, chh = 190;
    var cL = -cw * 0.5, cT = deck - chh;
    ctx.fillStyle = 'rgba(17,19,23,0.88)';
    ctx.fillRect(cL, cT, cw, chh);
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(168,178,194,0.85)';
    ctx.strokeRect(cL, cT, cw, chh);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(150,160,176,0.45)';
    ctx.beginPath();
    for (pk = 1; pk <= 3; pk++) {
      ctx.moveTo(cL + (cw / 4) * pk, cT); ctx.lineTo(cL + (cw / 4) * pk, cT + chh);
    }
    ctx.moveTo(cL, cT + chh * 0.34); ctx.lineTo(cL + cw, cT + chh * 0.34);
    ctx.moveTo(cL, cT + chh * 0.68); ctx.lineTo(cL + cw, cT + chh * 0.68);
    ctx.stroke();
    // Roof plate, with the hazard stripe every hoist cage in the world carries.
    ctx.fillStyle = '#c3cad6';
    ctx.fillRect(cL - 11, cT - 13, cw + 22, 13);
    ctx.fillStyle = 'rgba(240,186,44,0.9)';
    ctx.fillRect(cL - 11, cT - 5, cw + 22, 5);
    ctx.fillStyle = 'rgba(20,18,16,0.85)';
    for (pk = 0; pk < 8; pk++) ctx.fillRect(cL - 11 + pk * ((cw + 22) / 8), cT - 5, (cw + 22) / 16, 5);

    /* --- two worklights, the mouth's own lamps one size down ----------
     * BOTH EAST OF THE COLUMN NOW, strung across the ceiling of the room the
     * machine drives out into. There is no west wall to hang one on any more, and
     * the old pair straddled the shaft — which put one of them behind the parked
     * hull, where a lamp lights nothing. Spaced so the near one covers the landing
     * and the far one reaches the room's mouth into the field, which is also what
     * keeps the red board's own emissive glow inside the same brightness band as
     * the lamps (see BOARD_RISE). Same warm colour as the portal floods: a station
     * is the same worksite, further down. */
    var lx, ly = cy - STATION_RY * 0.52;
    for (pk = 0; pk < 2; pk++) {
      lx = pk ? STATION_FWD - 120 : SHAFT_HALF + 70;
      ctx.fillStyle = '#3b3f47';
      ctx.fillRect(lx - 7, ly - 9, 14, 9);
      ctx.fillStyle = 'rgba(24,26,30,0.9)';
      ctx.fillRect(lx - 2, ly, 4, 9);
      lampGlow(ctx, lx, ly, 116, 'rgba(255,214,138,', 0.48 * flick);
      ctx.fillStyle = 'rgba(255,236,190,' + (0.95 * flick).toFixed(3) + ')';
      ctx.fillRect(lx - 5, ly - 7, 10, 5);
    }

    /* --- THE BIG RED READOUT -----------------------------------------
     * HUNG IN THE SHAFT, DIRECTLY OVER THE STATION OPENING — not inside the
     * chamber. The machine is about 340 units long and the chamber is 400 tall,
     * so a board hung under the chamber ceiling is a board the parked machine
     * stands in front of, which is the one place it must never be. In the shaft
     * it is also where a real level board is: you read it on the way down, from
     * above, before you arrive.
     *
     * It is scaled to fit inside the shaft lining if the figures ever make a
     * board wider than that — a sign 8% smaller beats a sign with its ends
     * buried in rock.
     *
     * HOW HIGH it hangs is BOARD_RISE, and that number is set by the darkness
     * composite rather than by the carpentry — see the note on it.
     */
    var g = boardGeom(i, cy);
    if (!g) return;

    // Hangers up to the nearest thing to hang it from, and a shadow under it, so
    // the board is BOLTED INTO the shaft rather than floating in it. These are
    // GEOMETRY — they stay in this pass and darken with the rock, which is
    // exactly right for unlit brackets.
    ctx.fillStyle = 'rgba(44,38,36,0.92)';
    ctx.fillRect(-g.pw * 0.30, g.py - 16, 8, 18);
    ctx.fillRect(g.pw * 0.30 - 8, g.py - 16, 8, 18);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(-g.pw * 0.5, g.py + g.ph, g.pw, 7);
    /* The board itself is NOT drawn here any more. It used to be, with a glow
     * and a comment claiming that made it "survive the darkness composite" — it
     * cannot: this pass runs BEFORE effects.renderDarkness(), and nothing under
     * a multiply-towards-black survives it. Measured at tier-0 lights the big
     * red figures were crushed to near-black, which defeated the one thing the
     * owner asked of them. The board now draws in renderLit(), which adv.js
     * calls AFTER the darkness — an LED sign is a light source, not geometry. */
  }

  /** Board geometry, shared by the geometry pass and the lit pass so the two
   *  can never drift apart. Returns a REUSED object — read, do not stash. */
  var boardG = { pw: 0, ph: 0, py: 0, art: null };
  function boardGeom(i, cy) {
    var art = stArt[i];
    if (!art) return null;
    var maxW = (SHAFT_HALF - 17) * 2;
    var sc = art.w > maxW ? maxW / art.w : 1;
    boardG.pw = art.w * sc;
    boardG.ph = art.h * sc;
    boardG.py = cy - BOARD_RISE - boardG.ph;
    boardG.art = art;
    return boardG;
  }

  /**
   * THE EMISSIVE PASS — everything on the lift that is genuinely a light.
   *
   * Called by adv.renderWorld() AFTER effects.renderDarkness(), inside the same
   * world transform, so the red boards read at full brightness however far the
   * headlight reaches. Near the machine this draws over an already-lit board
   * position and changes nothing visible; in the dark it is the difference
   * between a legible level sign and a black rectangle. Same reasoning the
   * scanner arrows would deserve if they were not already instrument overlay.
   *
   * Culling matches drawLift()'s exactly, and the flicker REUSES the phase that
   * drawLift advanced this frame (liftFlick) rather than advancing it again —
   * two advances per frame would double the flicker rate and desync the lamps
   * below the boards from the boards themselves.
   */
  function renderLit(ctx) {
    if (!loaded) return;
    var v = SM.camera.getViewBounds();
    var vTop = v.minY - 40, vBot = v.maxY + 40;
    var lo = liftDrawLo(), hi = liftDrawHi();
    if (lo > ELEV_X - DAY_GLOW_R) lo = ELEV_X - DAY_GLOW_R;
    if (hi < ELEV_X + DAY_GLOW_R) hi = ELEV_X + DAY_GLOW_R;
    if (v.maxX < lo || v.minX > hi) return;

    /* SAME TRANSLATE AS drawLift(). Everything below is shaft-local, which is
     * what keeps this pass and the geometry pass sharing boardGeom() without a
     * second copy of the x arithmetic. */
    ctx.save();
    ctx.translate(ELEV_X, 0);

    /* --- DAYLIGHT IS A LIGHT SOURCE, SO IT DRAWS HERE ------------------
     * drawMouth() paints the sky in the GEOMETRY pass, where the darkness
     * composite then multiplies it towards black — the same trap the level boards
     * were in. Measured at the surface with tier-0 lamps: outside the headlight
     * the #8194ab sky transmits at 6% and comes out as rgb(8,9,10), so the one
     * thing the mouth is supposed to say — THIS IS THE WAY OUT — was only legible
     * if you were already standing in it.
     *
     * That was survivable while the mouth was in the middle of the mine and every
     * run started and ended there. It is not survivable now: the workings run
     * 4700 units east of the head under a rock roof, so coming home is a
     * navigation problem it never used to be, and the exit has to be visible from
     * further away than the headlight reaches.
     *
     * Deliberately ONE cached radial glow and no beacon: it is culled with the
     * mouth, so a player 300 m down sees nothing of it — which is correct, there
     * is a mine's worth of rock in the way. */
    var ceil = A.MINE_CEILING_Y;
    if (vTop < ceil + DAY_GLOW_R && vBot > ceil - DAY_GLOW_R) {
      lampGlow(ctx, MOUTH_DX * 0.4, ceil + 40, DAY_GLOW_R,
               'rgba(188,208,234,', DAY_GLOW_A);
    }

    if (!liftApi || !stN) { ctx.restore(); return; }
    for (var i = 0; i < stN; i++) {
      var cy = stY[i];
      if (cy - STATION_RY - 340 > vBot) continue;
      if (cy + STATION_RY + 60 < vTop) continue;
      var g = boardGeom(i, cy);
      if (!g) continue;
      // The light the board throws on the shaft around it, then the sign.
      lampGlow(ctx, 0, g.py + g.ph * 0.5, 210, 'rgba(255,58,34,', 0.34 * liftFlick);
      ctx.save();
      ctx.globalAlpha = 0.94 + 0.06 * liftFlick;
      ctx.drawImage(g.art.cv, -g.pw * 0.5, g.py, g.pw, g.ph);
      ctx.restore();
    }
    ctx.restore();
  }

  /* The world-x span the lift PAINTS into, which is a little wider than the span
   * it CARVES (liftXLo/liftXHi): the headframe posts, the deck kerbs and the
   * board's own glow all overhang the excavation. One pair of helpers so the
   * geometry pass and the emissive pass cull identically — they must, or a board
   * appears at a view position its own shaft does not. */
  function liftDrawLo() { return ELEV_X - STATION_BACK - 70; }
  function liftDrawHi() { return ELEV_X + STATION_FWD + 70; }

  /**
   * A rounded-rectangle path spanning x in [xL, xR], centred on cy in y. Built by
   * hand rather than with ctx.roundRect(): one less canvas API to depend on, and
   * the corner radius is clamped here where it is obvious why.
   *
   * ASYMMETRIC IN X because a station room at the mine's edge is (see
   * STATION_BACK / STATION_FWD).
   */
  function roomPath(ctx, xL, xR, cy, ry, r) {
    var rx = (xR - xL) * 0.5;
    if (r > rx * 0.9) r = rx * 0.9;
    if (r > ry * 0.9) r = ry * 0.9;
    var L = xL, R = xR, T = cy - ry, B = cy + ry;
    ctx.beginPath();
    ctx.moveTo(L + r, T);
    ctx.lineTo(R - r, T);
    ctx.quadraticCurveTo(R, T, R, T + r);
    ctx.lineTo(R, B - r);
    ctx.quadraticCurveTo(R, B, R - r, B);
    ctx.lineTo(L + r, B);
    ctx.quadraticCurveTo(L, B, L, B - r);
    ctx.lineTo(L, T + r);
    ctx.quadraticCurveTo(L, T, L + r, T);
    ctx.closePath();
  }

  /**
   * THE NEXT LEVEL DOWN, UNOWNED. A boarded-up continuation of the shaft with
   * the same sign switched off. Deliberately cheap and deliberately dark: it is
   * there so that "there is more down there, and it is for sale" is something
   * the world says on the way past, not only a row in a menu.
   */
  function drawHint(ctx, vTop, vBot) {
    if (!stN) return;
    var y = shaftBotY;                       // the bottom of the sump
    if (y - SHAFT_SUMP > vBot + 40 || y + HINT_H < vTop - 40) return;

    // The boards across the bottom of the sump, braced, with the shadow of
    // whatever is under them.
    ctx.fillStyle = 'rgba(84,58,34,0.95)';
    ctx.fillRect(-SHAFT_HALF, y - 14, SHAFT_HALF * 2, 14);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(-SHAFT_HALF, y - 5, SHAFT_HALF * 2, 5);
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(74,51,31,0.8)';
    ctx.beginPath();
    ctx.moveTo(-SHAFT_HALF + 4, y - 16); ctx.lineTo(SHAFT_HALF - 4, y - 62);
    ctx.moveTo(SHAFT_HALF - 4, y - 16); ctx.lineTo(-SHAFT_HALF + 4, y - 62);
    ctx.stroke();

    // The continuation below the boards, fading away into the rock. Cheap, and
    // deliberately almost nothing: it is a suggestion, not a promise.
    var g = ctx.createLinearGradient(0, y, 0, y + HINT_H);
    g.addColorStop(0, 'rgba(5,4,6,0.75)');
    g.addColorStop(1, 'rgba(5,4,6,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-SHAFT_HALF + 8, y);
    ctx.lineTo(SHAFT_HALF - 8, y);
    ctx.lineTo(SHAFT_HALF * 0.40, y + HINT_H);
    ctx.lineTo(-SHAFT_HALF * 0.40, y + HINT_H);
    ctx.closePath();
    ctx.fill();

    /* The next level's own board, hanging over the boarded-up shaft with its
     * lamps off. The SAME sign design as a station's, dark — which is the whole
     * argument for building the dark variant at all: the player already knows
     * what a lit one means. */
    if (!nextArt) return;
    var w = nextArt.w * 0.60, h = nextArt.h * 0.60;
    if (w > (SHAFT_HALF - 14) * 2) {
      var k = (SHAFT_HALF - 14) * 2 / w;
      w *= k; h *= k;
    }
    /* Low in the sump, sitting on the boards. Not for looks: a machine parked in
     * the cage above has its drill hanging into the top of the sump, and a sign
     * mounted any higher is a sign behind the bit. */
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(nextArt.cv, -w * 0.5, y - 20 - h, w, h);
    ctx.restore();
  }

  /**
   * All three pieces, and the one flicker phase they share.
   *
   * THE WHOLE LIFT IS DRAWN IN SHAFT-LOCAL SPACE. One translate to ELEV_X here
   * rather than an ELEV_X term in every fillRect below it: the column, the
   * headframes, the decks, the cages, the sump boards and the level boards are all
   * expressed as offsets from the centreline, so relocating the lift is one
   * transform and no arithmetic — and the emissive pass (renderLit) does the same
   * translate, which is what stops the two from ever drifting apart.
   */
  function drawLift(ctx, vLeft, vTop, vRight, vBot) {
    if (!liftApi) return;
    // The column is off to one side (which, in a 5200-wide mine, is most of it).
    if (vRight < liftDrawLo() || vLeft > liftDrawHi()) return;

    /* One monotonic phase, as at the mouth: the lamps must not jump when a band
     * streams out and back in, so the flicker is a pure function of it. The
     * value is kept on `liftFlick` for renderLit(), which runs after the
     * darkness composite and must flicker IN STEP with the lamps here. */
    liftPhase += 0.016;
    var flick = 0.92 + 0.08 * Math.sin(liftPhase * 2.1) * Math.sin(liftPhase * 0.6 + 0.7);
    liftFlick = flick;

    ctx.save();
    ctx.translate(ELEV_X, 0);
    drawShaft(ctx, vTop, vBot);
    for (var i = 0; i < stN; i++) {
      if (stY[i] - STATION_RY - 340 > vBot) continue;
      if (stY[i] + STATION_RY + 60 < vTop) continue;
      drawStation(ctx, i, flick);
    }
    drawHint(ctx, vTop, vBot);
    ctx.restore();
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
      // LAST of the in-rock draws: the lift is built THROUGH the strata and the
      // old workings, so it has to paint over both.
      drawLift(ctx, rockL, sTop, rockR, vBot);

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
    piles: 0, pilesUp: 0, deepestM: 0, layer: '',
    liftApi: false, stations: 0, shaftBotM: 0, nextLevelM: 0,
    elevX: 0, elevXLo: 0, elevXHi: 0
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
    dbg.liftApi = liftApi;
    dbg.stations = stN;
    dbg.shaftBotM = stN ? depthOfY(shaftBotY) : 0;
    dbg.nextLevelM = nextOn ? depthOfY(nextY) : 0;
    // The elevator column, and the world-x box its excavation can reach.
    dbg.elevX = ELEV_X;
    dbg.elevXLo = liftReach ? liftXLo : ELEV_X;
    dbg.elevXHi = liftReach ? liftXHi : ELEV_X;
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
    renderLit: renderLit,

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
    /**
     * Where the machine gets in and out: the elevator column, just inside the
     * mine's WEST wall. THE ONE SOURCE OF TRUTH for the shaft's x — js/adv.js's
     * mouthX()/getStationX(), the cage circles, getDistanceToExit() and
     * js/vehicle.js's park all resolve through this getter, so nothing else in
     * the codebase should ever spell the number out.
     */
    getMouthX: function () { return ELEV_X; },
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
    /* --- THE LIFT (see the section of that name) -----------------------
     * The station cage zone Agent 1 codes against is a circle of
     * ADV.EXIT_RADIUS centred on (getMouthX(), getStationY(k)); the shaft is the
     * column at getMouthX() +- getShaftHalfWidth(). Everything here is derived
     * from SM.adv.getLevels(), so this side never decides what is owned. */
    /** Half-width of the carved shaft column, world units. */
    getShaftHalfWidth: function () { return SHAFT_HALF; },
    /** How many OWNED stations this module has resolved for the live mine. */
    getStationCount: function () { return stN; },
    /** World y of station k, shallowest first, or NaN. */
    getStationY: function (k) { return (k >= 0 && k < stN) ? stY[k] : NaN; },
    /** Depth in metres of station k, as the level declared it, or NaN. */
    getStationDepthM: function (k) { return (k >= 0 && k < stN) ? stDepthM[k] : NaN; },
    /** Level number (getLevels()[].i) of station k, or -1. */
    getStationLevel: function (k) { return (k >= 0 && k < stN) ? stLevel[k] : -1; },
    /** True where the lift's own excavation has removed the rock. */
    isLiftVoid: inLiftVoid,
    /**
     * Re-read the level table NOW and re-open the resident band. Called for you
     * on `lift:bought` and on a poll; exposed so a caller that would rather be
     * explicit than trust an event can be.
     */
    refreshLift: function () { resolveLevels(); reopenLift(); },

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
