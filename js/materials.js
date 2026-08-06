/* =============================================================================
 * SUPERMINE — js/materials.js                     [OWNER: Agent 2 — gameplay]
 * -----------------------------------------------------------------------------
 * DATA-DRIVEN MATERIAL TABLE.
 *
 * js/particles.js contains NO knowledge of any specific material. Every
 * behaviour — how hard it is, how it shatters, how bouncy the debris is, how
 * it is drawn — is read from this table at runtime. To add a new material you
 * only add an entry to SM.materials.list (and optionally a break style), then
 * reference its id from terrain.js. Nothing else needs to change.
 *
 * !! ORDERING MATTERS !!
 *   Materials are looked up by numeric index (Uint8 in the particle arrays).
 *   APPEND new materials at the end. Do not reorder or remove existing ones,
 *   and keep the count <= 255.
 *
 * FIELD REFERENCE  (every field is required unless marked optional)
 * ---------------------------------------------------------------------------
 *  id            string   stable key, used in event payloads and by terrain
 *  name          string   human label for the UI
 *  colors        [3]      [base, shadow, highlight] css colors used to bake
 *                         the sprite atlas. Any css color string works.
 *  hardness      number   "mining-power seconds" required to break one deposit.
 *                         Vehicle removes getMiningPower() points per second.
 *                         hardness 2.0 with power 20 => 0.1s of contact.
 *  value         number   total currency yielded by one deposit. Split evenly
 *                         across its debris, so partial collection pays less.
 *  radius        [min,max]world-unit radius range of the SOLID deposit.
 *  density       number   mass multiplier. Affects how far debris is thrown
 *                         (heavier = shorter throw) and collision response.
 *  restitution   number   0..1 bounciness of loose debris.
 *  friction      number   0..1 velocity retained per second-ish; LOWER = more
 *                         slippery/rolly. Gold uses a high value (rolls less).
 *  debrisCount   int      fragments produced when the deposit breaks.
 *  breakStyle    string   key into SM.materials.breakStyles (below).
 *  glow          bool     draw an additive bloom halo + sparkle.
 *  sparkle       number   optional 0..1, chance-weight of twinkle in effects.
 *  shape         string   optional 'round' | 'chunk' | 'shard'. Sprite silhouette.
 *                         Defaults to the break style's preferred shape.
 * ========================================================================== */

var SM = SM || {};

SM.materials = (function () {
  'use strict';

  /* -------------------------------------------------------------------------
   * BREAK STYLES
   * How a deposit converts into debris. particles.js reads these verbatim.
   *   debrisScale   fragment radius as a fraction of the parent radius
   *   speed         [min,max] initial fragment speed (world units / second)
   *   spread        radians of random cone around the "away from cutter" dir
   *   backBias      0..1 how much fragments are pushed back past the machine
   *                 (helps them land inside the collector radius)
   *   spin          [min,max] absolute angular velocity, rad/s
   *   drag          extra per-second drag multiplier on top of the global one
   *   jitter        random positional offset at spawn, in parent radii
   * ---------------------------------------------------------------------- */
  var breakStyles = {
    // Soft material that just falls apart into a small dusty heap.
    crumble: {
      debrisScale: 0.52, speed: [40, 150], spread: 1.5, backBias: 0.45,
      spin: [2, 9], drag: 1.5, jitter: 0.7, shape: 'round'
    },
    // Brittle material that cracks into a few fast, sharp, spinning shards.
    fracture: {
      debrisScale: 0.62, speed: [130, 340], spread: 1.0, backBias: 0.3,
      spin: [7, 22], drag: 0.6, jitter: 0.5, shape: 'shard'
    },
    // Precious/volatile material that erupts outward in every direction.
    burst: {
      debrisScale: 0.58, speed: [200, 460], spread: 2.6, backBias: 0.18,
      spin: [5, 18], drag: 0.35, jitter: 0.9, shape: 'chunk'
    },
    // Loose gravel that barely holds together — a puff of small chips.
    gravel: {
      debrisScale: 0.46, speed: [60, 210], spread: 2.2, backBias: 0.5,
      spin: [3, 14], drag: 1.9, jitter: 1.0, shape: 'chunk'
    },
    // End-game jackpot material: a full 360-degree firework of fast shards.
    // Deliberately the loudest style in the table — this is what the maxed
    // machine ploughs through in the final zone.
    shatter: {
      debrisScale: 0.50, speed: [270, 610], spread: 3.1, backBias: 0.12,
      spin: [9, 26], drag: 0.30, jitter: 1.15, shape: 'shard'
    }
  };

  /* -------------------------------------------------------------------------
   * THE MATERIAL TABLE
   * ---------------------------------------------------------------------- */
  var list = [
    {
      id: 'dirt', name: 'Dirt',
      colors: ['#7c5a3a', '#553c26', '#a07a52'],
      hardness: 0.55, value: 1,
      radius: [7.6, 10.4], density: 0.85,
      restitution: 0.14, friction: 0.92,
      debrisCount: 3, breakStyle: 'crumble', glow: false, sparkle: 0
    },
    {
      id: 'stone', name: 'Stone',
      colors: ['#6d737c', '#484d55', '#959ba4'],
      hardness: 2.1, value: 3,
      radius: [8.0, 10.8], density: 1.45,
      restitution: 0.30, friction: 0.84,
      debrisCount: 4, breakStyle: 'fracture', glow: false, sparkle: 0
    },
    {
      id: 'iron', name: 'Iron Ore',
      colors: ['#9fadbb', '#6d7b8a', '#d6e2ec'],
      hardness: 3.4, value: 12,
      radius: [8.0, 10.4], density: 2.10,
      restitution: 0.24, friction: 0.88,
      debrisCount: 4, breakStyle: 'fracture', glow: false, sparkle: 0.15
    },
    {
      id: 'gold', name: 'Gold',
      colors: ['#ffcb31', '#c9911a', '#fff3ab'],
      hardness: 2.9, value: 30,
      radius: [7.6, 10.0], density: 3.10,
      restitution: 0.10, friction: 0.95,   // heavy, rolls less
      debrisCount: 5, breakStyle: 'burst', glow: true, sparkle: 0.7
    },
    {
      id: 'gem', name: 'Gem',
      colors: ['#33dd80', '#12a05a', '#a5ffce'],
      hardness: 4.0, value: 55,
      radius: [7.0, 9.4], density: 0.95,
      restitution: 0.74, friction: 0.62,   // bouncy little things, ping around
      debrisCount: 5, breakStyle: 'burst', glow: true, sparkle: 1.0
    },
    {
      id: 'crystal', name: 'Crystal',
      colors: ['#48bcff', '#1f76cf', '#c2ecff'],
      hardness: 4.9, value: 85,
      radius: [7.8, 11.0], density: 1.20,
      restitution: 0.44, friction: 0.72,
      debrisCount: 6, breakStyle: 'fracture', glow: true, sparkle: 0.9,
      shape: 'shard'                       // fractures into sharp splinters
    },
    {
      id: 'rare', name: 'Voidstone',
      colors: ['#c46bff', '#7c22cf', '#f3d4ff'],
      hardness: 6.6, value: 190,
      radius: [8.2, 11.0], density: 1.65,
      restitution: 0.52, friction: 0.78,
      debrisCount: 7, breakStyle: 'burst', glow: true, sparkle: 1.0
    },

    /* ---------------------------------------------------------------------
     * PHASE 2 ADDITIONS (appended — indices 7, 8, 9)
     * ------------------------------------------------------------------ */
    {
      // Loose spoil that litters caverns and narrow passages. Almost free to
      // break; exists to make the floor feel dirty and physical, and to give
      // the collector something to hoover on the way through.
      id: 'rubble', name: 'Rubble',
      colors: ['#8b8175', '#5c554c', '#b6ac9d'],
      hardness: 0.30, value: 2,
      radius: [5.6, 8.2], density: 0.80,
      restitution: 0.34, friction: 0.80,
      debrisCount: 2, breakStyle: 'gravel', glow: false, sparkle: 0,
      shape: 'chunk'
    },
    {
      // The barrier material. Hard enough to visibly slow an under-powered
      // machine (this is the "greater risk of slowing down" lever) but nearly
      // worthless, so ploughing through it is a real cost.
      id: 'granite', name: 'Granite',
      colors: ['#5a6470', '#333a45', '#8f9bab'],
      hardness: 6.2, value: 6,
      radius: [8.6, 11.0], density: 2.40,
      restitution: 0.20, friction: 0.90,
      debrisCount: 5, breakStyle: 'fracture', glow: false, sparkle: 0
    },
    {
      // FINAL-ZONE JACKPOT. Big value, big hardness, biggest burst in the
      // table. A maxed machine deletes a wall of this per second.
      id: 'starcore', name: 'Starcore',
      colors: ['#ff7ad9', '#b81f8e', '#ffe6fb'],
      hardness: 8.0, value: 420,
      radius: [8.6, 11.0], density: 1.45,
      restitution: 0.58, friction: 0.68,
      debrisCount: 7, breakStyle: 'shatter', glow: true, sparkle: 1.0,
      shape: 'shard'
    },
    {
      // LATE-GAME BARRIER. Three times granite's hardness, so a mid-run rig
      // genuinely bogs down in it and only OVERDRIVE cuts it at full speed.
      // Deliberately placed only in the deep barrier / pressure lock walls.
      id: 'obsidian', name: 'Obsidian',
      colors: ['#3b3350', '#1b1728', '#8f7fc4'],
      hardness: 16.0, value: 40,
      radius: [8.6, 11.0], density: 2.80,
      restitution: 0.30, friction: 0.86,
      debrisCount: 5, breakStyle: 'fracture', glow: false, sparkle: 0.2,
      shape: 'shard'
    }
  ];

  /* -------------------------------------------------------------------------
   * Derived lookups, built once at load.
   * ---------------------------------------------------------------------- */
  var byId = Object.create(null);
  var i, m, s;
  for (i = 0; i < list.length; i++) {
    m = list[i];
    m.index = i;                                   // numeric index back-reference
    s = breakStyles[m.breakStyle] || breakStyles.crumble;
    m.style = s;                                   // resolved once, no lookups later
    if (!m.shape) m.shape = s.shape || 'round';
    if (m.sparkle === undefined) m.sparkle = 0;
    // Pre-split value so particles.js never divides on the hot path.
    m.debrisValue = m.value / Math.max(1, m.debrisCount);
    // Pre-compute inverse mass factor used by the collision solver.
    m.invDensity = 1 / Math.max(0.05, m.density);
    byId[m.id] = m;
  }

  /** Look up by numeric index (what the particle arrays store). */
  function get(index) { return list[index] || list[0]; }

  /** Look up by string id; returns undefined if unknown. */
  function getById(id) { return byId[id]; }

  /** Numeric index for a string id, or 0 (dirt) if unknown. */
  function indexOf(id) { var mm = byId[id]; return mm ? mm.index : 0; }

  return {
    list: list,
    breakStyles: breakStyles,
    count: list.length,
    get: get,
    getById: getById,
    indexOf: indexOf
  };
})();
