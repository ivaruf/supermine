/* =============================================================================
 * SUPERMINE — js/config.js
 * -----------------------------------------------------------------------------
 * ALL global tuning constants live here, grouped and commented.
 *
 * >>> THIS FILE IS FROZEN after Phase 1. <<<
 * Agents 2 and 3 must put their own new constants at the TOP of the files they
 * own (see ARCHITECTURE.md "File ownership"). Existing values here may be
 * re-tuned only with a very good reason, because several systems read them.
 *
 * WORLD ORIENTATION
 *   x  -> lateral (left negative, right positive), clamped to the lane
 *   y  -> forward is NEGATIVE y (the vehicle drives "up" the screen)
 *   So "depth" / "distance travelled" is  (startY - y)  and is always >= 0.
 *   There is no gravity: this is a top-down excavation view. Loose material is
 *   slowed by drag/friction instead of falling.
 * ========================================================================== */

var SM = SM || {};

SM.config = {

  /* ---------------------------------------------------------------------
   * 1. SIMULATION / LOOP
   * ------------------------------------------------------------------ */
  FIXED_DT: 1 / 60,            // seconds per simulation step
  MAX_STEPS_PER_FRAME: 5,      // anti "spiral of death" clamp
  MAX_FRAME_DT: 0.25,          // clamp for tab-switch hitches (seconds)

  /* ---------------------------------------------------------------------
   * 2. WORLD / LANE
   * ------------------------------------------------------------------ */
  LANE_HALF_WIDTH: 640,        // playfield spans x in [-640, +640]
  // NOTE: lane width, CAM_ZOOM and TERRAIN_SPACING are COUPLED. The lane must
  // fill most of a 16:9 viewport at the default zoom or the screen reads as
  // two black bars with a strip of game between them. If you widen the lane,
  // raise TERRAIN_SPACING too or the particle budget explodes.
  WALL_THICKNESS: 90,          // visual thickness of the rock walls outside lane
  START_Y: 0,                  // vehicle spawn y
  START_CLEAR_RADIUS: 235,     // no terrain spawns within this of the start pad

  /* ---------------------------------------------------------------------
   * 3. PARTICLE SYSTEM (js/particles.js)
   * ------------------------------------------------------------------ */
  PARTICLE_CAPACITY: 7500,     // hard pool cap (pre-allocated, never grows)
  MAX_LOOSE: 1200,             // soft cap on simultaneously loose debris

  // --- Uniform spatial hash -------------------------------------------
  // Cell size should be >= the diameter of the biggest particle so a
  // 3x3 cell neighbourhood always contains every possible contact.
  GRID_CELL: 23,
  GRID_COLS: 128,              // power of two -> bitmask indexing
  GRID_ROWS: 256,              // power of two
  // Wrap-around footprint: 128*23 = 2944 world units in x (lane is 1280 wide)
  //                        256*23 = 5888 world units in y (window is ~1300)
  // Both comfortably exceed the live window, so hash aliasing never happens.

  // --- Integration / relaxation ---------------------------------------
  RELAX_ITERATIONS: 3,         // positional-correction passes per step
  CORRECTION_STRENGTH: 0.55,   // fraction of overlap resolved per iteration
  MAX_CORRECTION: 3.2,         // clamp per-contact push (world units) — anti-explode
  LOOSE_LINEAR_DRAG: 2.6,      // per-second exponential-ish drag on loose debris
  // Velocity clamp. Deliberately chosen so that MAX_SPEED * FIXED_DT (= 15)
  // stays below GRID_CELL (= 23): a particle can never skip a whole grid cell
  // in one step, which is what keeps the 3x3 neighbourhood scan correct.
  MAX_SPEED: 900,

  // --- Sleeping --------------------------------------------------------
  SLEEP_SPEED: 9,              // below this speed a loose particle accrues sleep
  SLEEP_TIME: 0.35,            // seconds under SLEEP_SPEED before it sleeps
  WAKE_SPEED: 22,              // impulse speed that re-wakes a sleeping particle

  // --- Collection (magnet) ---------------------------------------------
  // Debris gets a short window of FREE TUMBLING before the magnet can grab it.
  // Without this the collector swallows fragments the instant they spawn and
  // the destruction reads as "tiles vanishing" instead of "ground erupting".
  COLLECT_DELAY: 0.34,         // seconds of tumbling before capture is allowed
  // Homing is a STEERING behaviour, not a force. A pure attractive force with
  // no damping makes particles orbit the collector forever and never arrive.
  COLLECT_ACCEL: 5200,         // ramp rate of the desired speed (units/s per s)
  COLLECT_START_SPEED: 150,    // desired speed at the moment of capture
  COLLECT_SEEK: 16,            // how fast velocity aligns with the desired vector
  COLLECT_SWIRL: 0.55,         // tangential bias -> curved, magnetic-looking arc
  COLLECT_MAX_SPEED: 1250,
  COLLECT_SNAP_DIST: 16,       // within this -> counted and recycled
  COLLECT_SPIN: 14,            // rad/s spin while flying home (visual)

  // --- Rendering -------------------------------------------------------
  SPRITE_SIZE_STEPS: 8,        // radius buckets in the sprite atlas
  SPRITE_SHADE_STEPS: 3,       // lighting/tone variants per size
  SPRITE_ROT_STEPS: 8,         // pre-baked rotations (avoids ctx.rotate per particle)
  SPRITE_MIN_RADIUS: 2.6,      // smallest bucket radius
  SPRITE_MAX_RADIUS: 11.0,     // largest bucket radius (must be <= GRID_CELL/2)
  LOW_DETAIL_ZOOM: 0.45,       // below this zoom, draw cheap squares instead of sprites
  CULL_MARGIN: 40,             // world units of slack around the view for culling
  STREAM_VIEW_MARGIN: 170,     // world units generated beyond the visible edge

  /* ---------------------------------------------------------------------
   * 4. TERRAIN STREAMING (js/terrain.js)
   * ------------------------------------------------------------------ */
  TERRAIN_SPACING: 18.0,       // jittered-grid spacing between deposits
  TERRAIN_JITTER: 0.34,        // fraction of spacing used as random offset
  BAND_HEIGHT: 90,             // one generation band (world units tall)
  STREAM_AHEAD: 840,           // generate this far in front of the vehicle
  STREAM_BEHIND: 400,          // despawn material further behind than this
  POCKETS_PER_BAND: 0.85,      // expected number of ore pockets per band
  POCKET_MIN_R: 55,
  POCKET_MAX_R: 165,

  /* ---------------------------------------------------------------------
   * 5. VEHICLE (js/vehicle.js)
   * ------------------------------------------------------------------ */
  VEHICLE_SPEED: 200,          // base forward speed (world units / second)
  VEHICLE_MIN_SPEED_FACTOR: 0.34,  // hardest material can slow you to this
  VEHICLE_STEER_ACCEL: 2600,   // lateral acceleration from steering
  VEHICLE_STEER_MAX: 330,      // max lateral speed
  VEHICLE_STEER_DRAG: 9.0,     // lateral damping when not steering
  VEHICLE_BODY_WIDTH: 96,      // chassis width
  VEHICLE_BODY_LENGTH: 158,    // chassis length (along y)
  VEHICLE_BLADE_WIDTH: 140,    // starting cutter width
  VEHICLE_BLADE_DEPTH: 34,     // how far the cut region reaches in front
  VEHICLE_MINING_POWER: 21,    // hardness-points removed per second
  VEHICLE_COLLECT_RADIUS: 215, // magnet radius around the collector
  VEHICLE_BANK_MAX: 0.20,      // radians of visual tilt at full lateral speed
  VEHICLE_TRANSFORM_TIME: 0.85,// seconds of upgrade morph animation
  VEHICLE_RESISTANCE_SCALE: 0.0055, // blocked-hardness -> slowdown conversion

  /* ---------------------------------------------------------------------
   * 6. CAMERA (js/camera.js)
   * ------------------------------------------------------------------ */
  CAM_FOLLOW: 7.5,             // follow stiffness (higher = tighter)
  CAM_LOOKAHEAD: 175,          // world units pushed ahead of the vehicle
  CAM_LATERAL_LEAD: 0.55,      // how much of the vehicle's x the camera adopts
  CAM_ZOOM: 0.95,              // default zoom (frames the full lane on 16:9)
  CAM_ZOOM_LERP: 2.4,
  CAM_ZOOM_MIN: 0.62,          // below this the lane stops filling the screen
  CAM_ZOOM_MAX: 1.60,
  CAM_SHAKE_DECAY: 4.2,        // per-second exponential decay of shake
  CAM_SHAKE_MAX: 34,           // clamp on shake amplitude (screen-ish units)
  CAM_REFERENCE_HEIGHT: 900,   // design resolution height for zoom normalisation

  /* ---------------------------------------------------------------------
   * 7. LEVEL / UPGRADES (js/level.js, js/upgrades.js)
   * ------------------------------------------------------------------ */
  LEVEL_LENGTH: 34000,         // world units from start to 100% progress (~3.5 min)
  FIRST_GATE_DISTANCE: 1550,   // distance travelled before the slice's gate
  GATE_WIDTH: 300,             // clear opening width of an upgrade gate
  GATE_CARVE_DEPTH: 140,       // terrain carved out around a gate (y extent)

  /* ---------------------------------------------------------------------
   * 8. EFFECTS (js/effects.js) — visual-only pool, no gameplay impact
   * ------------------------------------------------------------------ */
  FX_CAPACITY: 1200,
  FX_BUDGET_PER_STEP: 90,      // hard cap on new fx per simulation step
  FX_DUST_LIFE: 0.55,
  FX_SPARK_LIFE: 0.34,

  /* ---------------------------------------------------------------------
   * 9. SOUND (js/sound.js)
   * ------------------------------------------------------------------ */
  SOUND_MASTER_GAIN: 0.28,
  SOUND_MIN_INTERVAL: 0.045,   // per-name rate limit in seconds

  /* ---------------------------------------------------------------------
   * 10. INPUT (js/input.js)
   * ------------------------------------------------------------------ */
  INPUT_DRAG_RANGE: 170,       // px of pointer travel that equals full steer
  INPUT_KEY_RAMP: 12.0,        // how fast keyboard steer reaches +-1

  /* ---------------------------------------------------------------------
   * 11. DEBUG
   * ------------------------------------------------------------------ */
  DEBUG_STATS: true            // draw the fps / particle-count readout
};

/* =============================================================================
 * ADVENTURE MODE — SHARED CONSTANTS
 * -----------------------------------------------------------------------------
 * >>> FROZEN. Read these; do not add to them. <<<
 * Only values that MORE THAN ONE adventure module must agree on live here.
 * Everything else belongs in the "tunables" block at the top of the file that
 * owns it (see ADVENTURE.md "File ownership").
 *
 * ORIENTATION IS UNCHANGED from classic SUPERMINE:
 *   -y is UP (towards the surface / the mine mouth), +y is DOWN (deeper).
 *   Depth in metres is  (y - MINE_CEILING_Y) * METERS_PER_UNIT, clamped at 0.
 *   There is still NO GRAVITY. Adventure movement is direct 2D drive: the
 *   machine crawls where the stick points and stops when the stick is centred.
 * ========================================================================== */
SM.config.ADV = {

  /* --- scale ---------------------------------------------------------- */
  METERS_PER_UNIT: 0.1,        // 10 world units = 1 metre of depth
  MINE_CEILING_Y: 0,           // y of the mine mouth; depth 0 m
  MINE_HALF_WIDTH: 2600,       // mines span x in [-2600, +2600] — 5200 units, 520 m across

  /* --- terrain window -------------------------------------------------
   * The resident set is a RECTANGLE OF CELLS in both axes, sized from the
   * camera view plus STREAM_MARGIN and freed with
   * particles.despawnOutsideRect(). That is what makes a wide mine affordable:
   * the screen only ever shows ~2000 units across, so width costs no extra
   * resident particles and no extra draw calls — only a bigger carve mask, one
   * byte per cell.
   *
   * THE LIMIT ON THE WINDOW IS NOT THE POOL, IT IS THE SPATIAL HASH.
   * particles.js wraps its grid with a bitmask over GRID_COLS x GRID_CELL =
   * 2944 units in x and GRID_ROWS x GRID_CELL = 5888 in y. Two live particles
   * further apart than that alias into the same hash cell and collision
   * detection corrupts silently. js/advterrain.js clamps the live extent to
   * 2800 x 5600 for that reason. Widening the MINE is free; widening the
   * WINDOW past those numbers is not, and would need GRID_COLS raised.
   * ------------------------------------------------------------------ */
  SPACING: 21,                 // adventure deposit pitch
  SOLID_BUDGET: 5200,          // hard ceiling on resident SOLID particles
  STREAM_MARGIN: 240,          // generate this far beyond the visible edge

  /* --- camera --------------------------------------------------------- */
  CAM_ZOOM: 0.80,             // fixed adventure zoom; lane-fit auto-zoom is OFF

  /* --- run pressures -------------------------------------------------- */
  EXIT_RADIUS: 200,            // within this of the mine mouth = extracted

  /* --- persistence ---------------------------------------------------- */
  SAVE_KEY: 'supermine.adventure.v1',
  SAVE_SLOTS: 3,
  SAVE_VERSION: 1
};
