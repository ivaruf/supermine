/* =============================================================================
 * SUPERMINE — js/save.js                         [OWNER: Agent 2 — PROGRESSION]
 * -----------------------------------------------------------------------------
 * THREE MINING COMPANIES IN localStorage. Each slot is one company: its cash,
 * its day counter, its machine, the mining rights it holds, and the state of
 * every mine it has dug — including the tunnels it left behind.
 *
 * ---------------------------------------------------------------------------
 * THE SAVE RECORD
 *   {
 *     v: 1,                        // SM.config.ADV.SAVE_VERSION
 *     company: 'Deep Rock Ltd',
 *     day: 47,
 *     cash: 128450,
 *     integrity: 0.62,             // HULL, as a 0..1 FRACTION. See the note below.
 *     rig: { drill:3, engine:2, ... },        // from SM.rig.getState()
 *     mines: {
 *       old_creek: {
 *         owned: true,
 *         levels: 2,                          // LIFT STATIONS bought, see below
 *         rails: [3, 1],                      // RAIL CHECKPOINTS bought per level
 *         visits: 12,
 *         deepestM: 173,                      // best depth reached, for the map card
 *         mask: '<rle>',                      // carved cells, see below
 *         piles: [ [x, y, matIndex, units], ... ]   // cargo dumped underground
 *       }
 *     },
 *     seen: { foothills: 1, ... },  // world-map regions surveyed (js/advui.js)
 *     stats: { hauled: 0, bestHaul: 0, runs: 0 }
 *   }
 *
 * LIFT STATIONS — `levels` IS A COUNT, NOT A SET
 *   A company buys the levels of a mine strictly in order, cheapest (shallowest)
 *   first, so the only thing worth storing is HOW MANY: `levels: 3` means levels
 *   1, 2 and 3 are owned and 4 is the next one for sale. A set would let a save
 *   describe a lift with a hole in it, which no purchase path can produce and
 *   which every consumer would then have to defend against.
 *
 *   Level 0 is the SURFACE station. It is not stored: it is owned by definition
 *   the moment the company holds the mining rights, exactly as a price-0 mine is
 *   always `owned`. A missing or nonsense `levels` migrates to 0 — no levels
 *   bought — which is the only safe direction and is what every record written
 *   before the lift existed says.
 *
 * RAIL CHECKPOINTS — `rails` IS AN ARRAY OF COUNTS, ONE PER LEVEL
 *   Rails run EAST from the lift inside a single level, and checkpoints on a
 *   level are bought strictly outward, so the same argument as `levels` applies
 *   one dimension over: the only thing worth storing per level is HOW MANY.
 *   `rails: [3, 1]` means level 1 has checkpoints 1-3 and level 2 has checkpoint
 *   1; every deeper level has none. Index i is LEVEL i+1 — there is no entry for
 *   level 0, because the surface has no rails.
 *
 *   A missing, short or nonsense `rails` migrates to all-zero: no track bought.
 *   Same reasoning as `levels` — it is the only safe direction, it is what every
 *   record written before rails existed says, and it does not warrant a
 *   SAVE_VERSION bump (which would delete every existing company; see below).
 *
 *   SECURED ORE IS NOT HERE, ON PURPOSE. Ore deposited at a checkpoint is RUN
 *   state: it is credited when the company next surfaces and it does not exist
 *   between runs. Reloading mid-run was never supported — there is nowhere to
 *   store "the machine is 400 m down with a part tank" — so persisting the
 *   secured ledger alone would let a reload bank it twice.
 *
 * HULL INTEGRITY — MIND THE UNITS
 *   Stored here as a 0..1 FRACTION, because that is what SM.adv.getIntegrity()
 *   is contracted to return and what js/adv.js reads and writes on this record.
 *   SM.mines.repairPrice() is quoted per POINT on a 0..100 scale, which is a
 *   different unit on purpose (money is quoted in whole points). The bridge in
 *   both directions is SM.mines.repairCost(fraction) -> whole dollars; never
 *   multiply repairPrice() by a fraction.
 *
 *   A record with no `integrity` migrates to 1.0 — a sound hull. That is the
 *   only safe direction: the alternative is inventing damage a player never
 *   took. It is also why this did NOT warrant a SAVE_VERSION bump, quite apart
 *   from js/config.js being frozen — validateRecord() drops any record whose `v`
 *   is not SAVE_VERSION, so bumping the version to add an optional field would
 *   delete every company that already exists to fix a missing number that
 *   defaults correctly anyway.
 *
 * >>> ADDING A FIELD: this validator DROPS keys it does not know, which makes
 * >>> every new field a silent data-loss bug until it is listed here. Two got in
 * >>> that way (`integrity` from js/adv.js and `seen` from js/advui.js: hull
 * >>> damage healed on reload and surveyed map regions re-fogged). If you write
 * >>> a new key on the record, ADD IT TO validateRecord() in the same commit —
 * >>> and if a value is mysteriously not persisting, call
 * >>> SM.save.getDroppedKeys() and it will be the first thing you see.
 *
 * THE CARVE MASK — why it is a string
 *   js/advterrain.js keeps a Uint8Array with one byte per generation cell of a
 *   mine (roughly 84 x 900 for a deep one) marking what the player has already
 *   dug out. That is what makes tunnels PERSIST: geology is regenerated from
 *   the mine's seed every time a band streams in, and the mask subtracts what
 *   is gone. Raw, it is ~75 KB of almost entirely zeros; localStorage gets a
 *   RUN-LENGTH ENCODED string instead.
 *
 *   Agent 2 owns the encoding. Agent 3 owns the array. The seam is exactly:
 *     SM.advterrain.exportMask()  -> Uint8Array (or null if no mine is loaded)
 *     SM.advterrain.importMask(u8)
 *   Encode/decode must round-trip EXACTLY, and decode must survive garbage
 *   (a hand-edited localStorage, a half-written string) by returning null
 *   rather than throwing — a corrupt mask should cost the player their tunnels,
 *   never their company.
 *
 * HARD RULES
 *   1. NEVER throw. localStorage is absent in private mode on some browsers and
 *      throws on quota. Every entry point is wrapped; failure degrades to
 *      "this session is not saved" and the game keeps running.
 *   2. Writes are DEBOUNCED, never per-frame. flush() on the real moments:
 *      extraction, purchase, day rollover.
 *   3. Validate on load. An unknown mine id or part key is dropped, not
 *      trusted — a save from a future build must not crash this one.
 *
 * =============================================================================
 * ================  AGENT-2 DESIGN NOTES — THE MASK CODEC  ====================
 * =============================================================================
 *
 * THE WIRE FORMAT
 *
 *     "1" <fmt> "," <len base36> "," <val base36> "," <payload>
 *
 *   fmt 'A'  ALTERNATING. The mask is zeros plus ONE other value (the normal
 *            case — advterrain marks carved cells with a single flag), so only
 *            RUN LENGTHS are stored, alternating 0, val, 0, val, ... starting
 *            with the zero run. `val` carries the non-zero value. This halves
 *            the payload against storing (value,length) pairs, which matters:
 *            three slots x seven mines is 21 masks in one 5 MB origin quota.
 *   fmt 'P'  PAIRS. Fallback for a mask that uses more than one non-zero value
 *            (if Agent 3 ever stores per-cell material or damage there). Runs
 *            are explicit (value, length) varints.
 *
 *   Run lengths and values are VARINTs over a 64-symbol alphabet, 5 data bits
 *   per symbol: symbol index < 32 is the LAST digit and carries that value,
 *   index >= 32 is a continuation carrying index-32. Little-endian groups.
 *   So runs up to 31 cost one character, up to 1023 cost two, and the long
 *   all-zero stretches that dominate a real mask cost three or four.
 *
 *   The alphabet deliberately excludes ',' ':' '"' and '\\' so the payload is a
 *   single JSON string token and the header can be split on ',' with no
 *   escaping anywhere.
 *
 * WHY IT IS AS STRICT AS IT IS
 *   decodeMask() rejects, rather than repairs: an unknown symbol, a truncated
 *   varint, a zero-length run anywhere except the very first, a run sum that
 *   does not equal the declared length, a declared length that disagrees with
 *   advterrain's maskDims(), a value above 255, or anything over MASK_MAX_CELLS.
 *   All of those return null. Repairing a corrupt mask would hand Agent 3 a
 *   plausible-looking array describing tunnels that are not there, and the mine
 *   would generate solid rock inside the player's own shaft. Losing the tunnels
 *   is recoverable; lying about them is not.
 *
 * MEASURED (see the report): a realistic 84 x 900 mask with ~6% carved in
 * row-contiguous runs encodes to roughly 2.5 characters per run and round-trips
 * byte-for-byte; a fully random byte array falls back to 'P' and still
 * round-trips exactly.
 * ========================================================================== */

var SM = SM || {};

SM.save = (function () {
  'use strict';

  /* ----- Agent-2 tunables live here ----------------------------------- */

  var DEBOUNCE_MS = 1200;      // markDirty() coalescing window
  var MAX_COMPANY = 22;        // characters; the slot card is a fixed width
  var MAX_PILES = 400;         // per mine, so a griefed save cannot balloon
  var MASK_MAX_CELLS = 4000000;// sanity ceiling on a decoded mask
  var MASK_MAX_CHARS = 600000; // sanity ceiling on an encoded mask string
  var MAX_DAY = 100000;
  var MAX_CASH = 1e12;
  var MAX_SEEN = 64;           // world-map region keys; the catalogue has 7
  var MAX_KEY = 40;            // characters in any id used as an object key
  /* Lift stations bought in one mine. The deepest mine in the catalogue sells 4,
   * so this is a paranoia ceiling on a hand-edited save, not a game rule —
   * SM.adv clamps to what SM.mines.levelsOf() actually offers. */
  var MAX_LEVELS = 16;
  /* Rail checkpoints bought on ONE level. The catalogue sells 4, so this is the
   * same kind of paranoia ceiling as MAX_LEVELS — SM.adv clamps to what
   * SM.mines.checkpointsOf() actually offers. */
  var MAX_RAILS = 16;

  /* Set true to have every key validateRecord() discards printed once. Left OFF
   * because the build's bar is zero console output, but the list is always
   * available through getDroppedKeys() whether this is on or not. */
  var DEBUG_SAVE = false;

  /* 64 JSON-safe symbols. Indices 0..31 terminate a varint, 32..63 continue it.
   * ',' ':' '"' and '\' are absent on purpose — see the design note. */
  var ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$_';
  var UNALPHA = null;          // char code -> index, built once below

  var A = SM.config.ADV;
  var slots = [];          // index -> record or null
  var active = -1;         // currently loaded slot, -1 = none
  var record = null;       // LIVE record for the active slot

  var available = false;   // localStorage actually works
  var lastError = '';      // human-readable reason the last write failed
  var dirty = false;
  var timer = 0;
  var listenersBound = false;

  /* =====================================================================
   * THE MASK CODEC
   * ------------------------------------------------------------------
   * Kept at the top of the module and free of every other concern, because it
   * is the one piece of this file that has a provable contract.
   * ================================================================== */

  function buildUnalpha() {
    UNALPHA = new Int16Array(128);
    for (var i = 0; i < 128; i++) UNALPHA[i] = -1;
    for (i = 0; i < ALPHA.length; i++) UNALPHA[ALPHA.charCodeAt(i)] = i;
  }
  buildUnalpha();

  /** Little-endian base-32 varint. Appends to `parts`, which is joined once. */
  function putVarint(parts, n) {
    while (n >= 32) {
      parts.push(ALPHA.charAt(32 + (n % 32)));
      n = Math.floor(n / 32);
    }
    parts.push(ALPHA.charAt(n));
  }

  /**
   * RLE-encode a Uint8Array (or any array-like of small integers) to a string.
   * Returns '' for null/empty input — '' is the canonical "no mask" value and
   * decodeMask('') returns null, so the pair is closed.
   */
  function encodeMask(u8) {
    try {
      if (!u8 || typeof u8.length !== 'number' || u8.length === 0) return '';
      var len = u8.length;
      if (len > MASK_MAX_CELLS) return '';

      /* Pick the format: one distinct non-zero value -> alternating. */
      var only = 0, multi = false, i, v;
      for (i = 0; i < len; i++) {
        v = u8[i];
        if (v === 0) continue;
        if (only === 0) only = v;
        else if (v !== only) { multi = true; break; }
      }

      var parts = [];
      var runStart, cur;

      if (!multi) {
        /* --- format A: alternating run lengths, starting with the zero run.
         * A leading zero-length run is legal (and only legal) at index 0, which
         * is how a mask that begins with a carved cell is expressed. */
        parts.push('1A,');
        parts.push(len.toString(36));
        parts.push(',');
        parts.push((only & 255).toString(36));
        parts.push(',');
        var want = 0;                          // the value this run should hold
        i = 0;
        while (i < len) {
          runStart = i;
          while (i < len && u8[i] === want) i++;
          putVarint(parts, i - runStart);
          want = want === 0 ? only : 0;
          /* If `only` is 0 the whole array is zeros and one run covers it. */
          if (only === 0) break;
        }
        return parts.join('');
      }

      /* --- format P: explicit (value, length) pairs. */
      parts.push('1P,');
      parts.push(len.toString(36));
      parts.push(',0,');
      i = 0;
      while (i < len) {
        cur = u8[i] & 255;
        runStart = i;
        while (i < len && (u8[i] & 255) === cur) i++;
        putVarint(parts, cur);
        putVarint(parts, i - runStart);
      }
      return parts.join('');
    } catch (e) {
      return '';
    }
  }

  /**
   * Decode a mask string back to a Uint8Array.
   * -> Uint8Array on success, null on ANY problem. Never throws.
   * `expectedLength`, when a positive number, is enforced: pass
   * SM.advterrain.maskDims().cols * rows so a save from a build with different
   * mine dimensions is discarded instead of silently mis-shaped.
   */
  function decodeMask(str, expectedLength) {
    try {
      if (typeof str !== 'string') return null;
      if (str.length < 7 || str.length > MASK_MAX_CHARS) return null;
      if (str.charAt(0) !== '1') return null;

      var fmt = str.charAt(1);
      if (fmt !== 'A' && fmt !== 'P') return null;

      /* The payload alphabet excludes ',', so a well-formed string has exactly
       * three of them and the two header fields are pure base-36. Checking the
       * SHAPE before parseInt matters: parseInt('1.5', 36) is 1, so a sloppy
       * header would otherwise decode to a plausible-looking length. */
      var f = str.split(',');
      if (f.length !== 4) return null;
      if (f[0].length !== 2) return null;
      if (!/^[0-9a-z]{1,8}$/.test(f[1])) return null;
      if (!/^[0-9a-z]{1,2}$/.test(f[2])) return null;

      var len = parseInt(f[1], 36);
      if (!(len >= 0) || len !== Math.floor(len) || len > MASK_MAX_CELLS) return null;
      var only = parseInt(f[2], 36);
      if (!(only >= 0) || only !== Math.floor(only) || only > 255) return null;
      if (typeof expectedLength === 'number' && expectedLength > 0 &&
          expectedLength !== len) return null;

      var body = f[3];
      var out = new Uint8Array(len);
      var p = 0, written = 0;
      var n, mul, code, d, terminal;

      if (fmt === 'A') {
        if (len > 0 && only === 0) {
          /* All zeros: exactly one run, covering everything. */
          n = 0; mul = 1; terminal = false;
          while (p < body.length) {
            code = body.charCodeAt(p++);
            if (code > 127) return null;
            d = UNALPHA[code];
            if (d < 0) return null;
            if (d < 32) { n += d * mul; terminal = true; break; }
            n += (d - 32) * mul; mul *= 32;
          }
          if (!terminal || p !== body.length || n !== len) return null;
          return out;
        }
        var want = 0;
        var runIndex = 0;
        while (p < body.length) {
          n = 0; mul = 1; terminal = false;
          while (p < body.length) {
            code = body.charCodeAt(p++);
            if (code > 127) return null;
            d = UNALPHA[code];
            if (d < 0) return null;
            if (d < 32) { n += d * mul; terminal = true; break; }
            n += (d - 32) * mul; mul *= 32;
          }
          if (!terminal) return null;                    // truncated varint
          if (n === 0 && runIndex !== 0) return null;    // only run 0 may be empty
          if (written + n > len) return null;
          if (want !== 0 && n > 0) {
            for (var j = written; j < written + n; j++) out[j] = only;
          }
          written += n;
          want = want === 0 ? only : 0;
          runIndex++;
        }
        if (written !== len) return null;
        return out;
      }

      /* --- format P */
      while (p < body.length) {
        var val = 0;
        mul = 1; terminal = false;
        while (p < body.length) {
          code = body.charCodeAt(p++);
          if (code > 127) return null;
          d = UNALPHA[code];
          if (d < 0) return null;
          if (d < 32) { val += d * mul; terminal = true; break; }
          val += (d - 32) * mul; mul *= 32;
        }
        if (!terminal || val > 255) return null;
        n = 0; mul = 1; terminal = false;
        while (p < body.length) {
          code = body.charCodeAt(p++);
          if (code > 127) return null;
          d = UNALPHA[code];
          if (d < 0) return null;
          if (d < 32) { n += d * mul; terminal = true; break; }
          n += (d - 32) * mul; mul *= 32;
        }
        if (!terminal) return null;                      // odd number of varints
        if (n <= 0) return null;
        if (written + n > len) return null;
        if (val !== 0) {
          for (var k = written; k < written + n; k++) out[k] = val;
        }
        written += n;
      }
      if (written !== len) return null;
      return out;
    } catch (e) {
      return null;
    }
  }

  /* =====================================================================
   * localStorage PLUMBING — nothing below this line may throw
   * ================================================================== */

  function store() {
    try {
      return (typeof localStorage !== 'undefined') ? localStorage : null;
    } catch (e) {
      return null;                 // Safari private mode throws on the getter
    }
  }

  function probeStorage() {
    var s = store();
    if (!s) { lastError = 'localStorage unavailable'; return false; }
    try {
      s.setItem(A.SAVE_KEY + '.probe', '1');
      s.removeItem(A.SAVE_KEY + '.probe');
      return true;
    } catch (e) {
      lastError = 'localStorage is read-only or full';
      return false;
    }
  }

  function readRaw() {
    var s = store();
    if (!s) return null;
    try {
      return s.getItem(A.SAVE_KEY);
    } catch (e) {
      return null;
    }
  }

  /**
   * The only place anything is written. Two-stage degradation: a quota failure
   * retries WITHOUT the carve masks, because tunnels are the one part of a
   * company that is cheap to lose and expensive to store.
   */
  function writeRaw() {
    var s = store();
    if (!s) { available = false; return false; }

    /* NOTHING TO SAVE -> LEAVE NO TRACE. Every slot null means either the player
     * has never started a company or has just erased their last one. Writing
     * `{v:1,slots:[null,null,null]}` in that state would put a key in
     * localStorage for somebody who only ever played TIME ATTACK — and the
     * pagehide flush below means that would happen on the FIRST page unload, to
     * everyone. Removing it also does the right thing for the erase case. */
    var anySlot = false, si;
    for (si = 0; si < slots.length; si++) { if (slots[si]) { anySlot = true; break; } }
    if (!anySlot) {
      try { s.removeItem(A.SAVE_KEY); lastError = ''; return true; }
      catch (e) { return false; }
    }

    var payload = { v: A.SAVE_VERSION, slots: slots };
    var text;
    try {
      text = JSON.stringify(payload);
    } catch (e) {
      lastError = 'save could not be serialised';
      return false;
    }
    try {
      s.setItem(A.SAVE_KEY, text);
      lastError = '';
      return true;
    } catch (e) {
      lastError = 'storage full — tunnels dropped';
    }
    /* Retry with every mask stripped. */
    try {
      var lean = JSON.parse(text);
      var i, id;
      for (i = 0; i < lean.slots.length; i++) {
        if (!lean.slots[i] || !lean.slots[i].mines) continue;
        for (id in lean.slots[i].mines) {
          if (!lean.slots[i].mines.hasOwnProperty(id)) continue;
          lean.slots[i].mines[id].mask = '';
        }
      }
      s.setItem(A.SAVE_KEY, JSON.stringify(lean));
      return true;
    } catch (e2) {
      available = false;
      lastError = 'storage full — this session will not be saved';
      return false;
    }
  }

  /* =====================================================================
   * VALIDATION
   * ------------------------------------------------------------------
   * A record that came off disk is UNTRUSTED input: another build wrote it, or
   * the player edited it, or a quota failure truncated it. Everything is coerced
   * into range; anything unrecognisable is dropped rather than repaired.
   * ================================================================== */

  function num(v, dflt, lo, hi) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!(n === n) || n === Infinity || n === -Infinity) return dflt;
    if (n < lo) return lo;
    if (n > hi) return hi;
    return n;
  }

  function str(v, dflt, maxLen) {
    if (typeof v !== 'string') return dflt;
    var s = v.replace(/[ -]/g, '').substring(0, maxLen);
    return s.length ? s : dflt;
  }

  /* --- dropped-key diagnostics ----------------------------------------
   * Dropping unknown keys is the right behaviour for untrusted input, but it
   * turns "I added a field and it does not persist" into a bug you can only find
   * by measuring the game. So every discarded key is remembered, once, under the
   * path it appeared at ('record.integrity', 'mines[old_creek].foo'), and
   * getDroppedKeys() hands the list to whoever is confused. */
  var dropped = [];
  var droppedSeen = Object.create(null);

  function noteDropped(path) {
    if (droppedSeen[path]) return;
    droppedSeen[path] = 1;
    if (dropped.length < 64) dropped.push(path);
    if (DEBUG_SAVE && typeof console !== 'undefined' && console.warn) {
      console.warn('SM.save: dropped unknown save key "' + path +
                   '" — add it to validateRecord() in js/save.js');
    }
  }

  /** Keys validateRecord() has discarded this session. Read-only. */
  function getDroppedKeys() { return dropped; }

  /* Walk an incoming object and note every key that is not in `known`. */
  function auditKeys(obj, known, prefix) {
    if (!obj || typeof obj !== 'object') return;
    for (var k in obj) {
      if (!obj.hasOwnProperty(k)) continue;
      if (known.indexOf(k) < 0) noteDropped(prefix + '.' + k);
    }
  }

  var RECORD_KEYS = ['v', 'company', 'day', 'cash', 'integrity', 'rig',
                     'mines', 'seen', 'stats'];
  var MINE_KEYS = ['owned', 'levels', 'rails', 'visits', 'deepestM', 'mask',
                   'piles'];

  function knownMine(id) {
    if (!SM.mines || !SM.mines.count || SM.mines.count() === 0) return true;
    return !!SM.mines.get(id);
  }

  function blankMineState() {
    return { owned: false, levels: 0, rails: [], visits: 0, deepestM: 0,
             mask: '', piles: [] };
  }

  function validateMineState(o) {
    var out = blankMineState();
    if (!o || typeof o !== 'object') return out;
    auditKeys(o, MINE_KEYS, 'mines[]');
    out.owned = !!o.owned;
    /* LIFT STATIONS BOUGHT, as a count. Missing -> 0: a company from before the
     * lift existed owns the surface station and nothing else, which is exactly
     * how it played. See the header note. */
    out.levels = Math.floor(num(o.levels, 0, 0, MAX_LEVELS));
    /* RAIL CHECKPOINTS BOUGHT, one count per level, index i = level i+1. Missing
     * or short -> zeros: a company from before rails owns no track. See the
     * header note. Written back as a dense array so JSON.stringify cannot turn a
     * hole into `null` and hand the next load a NaN. */
    out.rails = [];
    /* `typeof === 'object'` as well as a numeric length, because a STRING is
     * array-like: without it a hand-edited `"rails": "3"` decodes to [3] — one
     * checkpoint the player never bought. Measured; it is the only shape in this
     * validator that could be read as something it is not. */
    if (o.rails && typeof o.rails === 'object' &&
        typeof o.rails.length === 'number') {
      var nl = o.rails.length < MAX_LEVELS ? o.rails.length : MAX_LEVELS;
      for (var r = 0; r < nl; r++) {
        out.rails.push(Math.floor(num(o.rails[r], 0, 0, MAX_RAILS)));
      }
    }
    out.visits = Math.floor(num(o.visits, 0, 0, 1e7));
    out.deepestM = Math.floor(num(o.deepestM, 0, 0, 1e6));
    out.mask = (typeof o.mask === 'string' && o.mask.length <= MASK_MAX_CHARS)
      ? o.mask : '';
    out.piles = [];
    if (o.piles && o.piles.length) {
      var n = o.piles.length < MAX_PILES ? o.piles.length : MAX_PILES;
      for (var i = 0; i < n; i++) {
        var p = o.piles[i];
        if (!p || p.length < 4) continue;
        var x = num(p[0], NaN, -1e7, 1e7);
        var y = num(p[1], NaN, -1e7, 1e7);
        var mi = Math.floor(num(p[2], -1, 0, 255));
        var un = num(p[3], 0, 0, 1e6);
        if (!(x === x) || !(y === y) || mi < 0 || !(un > 0)) continue;
        out.piles.push([x, y, mi, un]);
      }
    }
    return out;
  }

  function validateRig(o) {
    var out = {}, keys = (SM.rig && SM.rig.PART_KEYS) ? SM.rig.PART_KEYS : [];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var max = (SM.rig && SM.rig.maxTier) ? SM.rig.maxTier(k) : 0;
      out[k] = Math.floor(num(o ? o[k] : 0, 0, 0, max));
    }
    return out;
  }

  function validateRecord(o) {
    if (!o || typeof o !== 'object') return null;
    /* Version gate. There is only v1, so anything else is from a future build
     * and is dropped — the slot reads as empty rather than as a corrupt company. */
    if (Math.floor(num(o.v, -1, -1, 1e6)) !== A.SAVE_VERSION) return null;

    auditKeys(o, RECORD_KEYS, 'record');

    var rec = {
      v: A.SAVE_VERSION,
      company: str(o.company, 'UNNAMED', MAX_COMPANY),
      day: Math.floor(num(o.day, 1, 1, MAX_DAY)),
      /* Floor, not round: js/adv.js already rounds a sale's gross to whole
       * dollars at the moment it becomes money, precisely so this floor is a
       * no-op and the ledger cannot drift by a dollar across a save. Every other
       * money source is integral by construction (fuelCost and repairCost ceil,
       * part and rights prices are literals), so cash arrives here integral. */
      cash: Math.floor(num(o.cash, 0, 0, MAX_CASH)),
      /* HULL, 0..1. Missing -> 1.0, a sound hull: see the units note in the
       * header. NOT clamped through Math.floor — this one is a fraction. */
      integrity: num(o.integrity, 1, 0, 1),
      rig: validateRig(o.rig),
      mines: {},
      seen: {},
      stats: {
        hauled: Math.floor(num(o.stats ? o.stats.hauled : 0, 0, 0, MAX_CASH)),
        bestHaul: Math.floor(num(o.stats ? o.stats.bestHaul : 0, 0, 0, MAX_CASH)),
        runs: Math.floor(num(o.stats ? o.stats.runs : 0, 0, 0, 1e7))
      }
    };
    if (o.stats && typeof o.stats === 'object') {
      auditKeys(o.stats, ['hauled', 'bestHaul', 'runs'], 'record.stats');
    }
    if (o.mines && typeof o.mines === 'object') {
      for (var id in o.mines) {
        if (!o.mines.hasOwnProperty(id)) continue;
        if (typeof id !== 'string' || id.length > MAX_KEY) continue;
        if (!knownMine(id)) continue;              // a mine this build removed
        rec.mines[id] = validateMineState(o.mines[id]);
      }
    }
    /* SURVEYED WORLD-MAP REGIONS (js/advui.js). Validated STRUCTURALLY rather
     * than against SM.mines.regions(), because the region key is advui's to
     * choose (it slugifies) and coupling this validator to another module's
     * naming would drop legitimate data the day they rename one. A bounded
     * number of bounded string keys, every value normalised to 1. */
    if (o.seen && typeof o.seen === 'object') {
      var kept = 0;
      for (var rk in o.seen) {
        if (!o.seen.hasOwnProperty(rk)) continue;
        if (typeof rk !== 'string' || !rk.length || rk.length > MAX_KEY) continue;
        if (!o.seen[rk]) continue;
        if (++kept > MAX_SEEN) break;
        rec.seen[rk] = 1;
      }
    }
    return rec;
  }

  function freshRecord(companyName) {
    var rec = {
      v: A.SAVE_VERSION,
      company: str(companyName, 'NEW VENTURE', MAX_COMPANY),
      day: 1,
      cash: (SM.mines && SM.mines.startingCash) ? SM.mines.startingCash() : 900,
      integrity: 1,              // a new company's machine is battered, not broken
      rig: (SM.rig && SM.rig.getState) ? SM.rig.getState() : {},
      mines: {},
      seen: {},
      stats: { hauled: 0, bestHaul: 0, runs: 0 }
    };
    /* The starter mine's rights come with the company. */
    var starter = (SM.mines && SM.mines.getStarterId) ? SM.mines.getStarterId() : null;
    if (starter) {
      rec.mines[starter] = blankMineState();
      rec.mines[starter].owned = true;
    }
    return rec;
  }

  /* =====================================================================
   * LIFECYCLE
   * ================================================================== */

  function init() {
    var i;
    slots = [];
    for (i = 0; i < A.SAVE_SLOTS; i++) slots.push(null);
    active = -1;
    record = null;
    dirty = false;

    available = probeStorage();
    if (available) {
      var raw = readRaw();
      if (raw) {
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
        if (parsed && parsed.slots && parsed.slots.length) {
          var n = parsed.slots.length < A.SAVE_SLOTS ? parsed.slots.length : A.SAVE_SLOTS;
          for (i = 0; i < n; i++) slots[i] = validateRecord(parsed.slots[i]);
        }
      }
    }
    bindListeners();
  }

  /* A tab close or an app switch is the one moment a debounced write would be
   * lost, so both are flush points. No layout is read and nothing is built —
   * this is a listener, not DOM work in the fixed step. */
  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;
    try {
      if (typeof window === 'undefined' || !window.addEventListener) return;
      window.addEventListener('pagehide', flush, false);
      window.addEventListener('beforeunload', flush, false);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'hidden') flush();
        }, false);
      }
    } catch (e) { /* no window: nothing to bind, nothing to lose */ }
  }

  /* =====================================================================
   * SLOT MANAGEMENT
   * ================================================================== */

  function tierOfRig(rigState) {
    if (!rigState) return 1;
    var keys = (SM.rig && SM.rig.PART_KEYS) ? SM.rig.PART_KEYS : [];
    if (!keys.length) return 1;
    var sum = 0;
    for (var i = 0; i < keys.length; i++) sum += num(rigState[keys[i]], 0, 0, 99);
    return 1 + Math.floor(sum / keys.length);
  }

  function ownedIn(rec) {
    var n = 0, id;
    if (!rec || !rec.mines) return 0;
    for (id in rec.mines) {
      if (rec.mines.hasOwnProperty(id) && rec.mines[id].owned) n++;
    }
    return n;
  }

  /** Summaries for the slot picker. Always A.SAVE_SLOTS entries, never null. */
  function listSlots() {
    var out = [], i, r;
    for (i = 0; i < A.SAVE_SLOTS; i++) {
      r = slots[i];
      if (!r) {
        out.push({ index: i, empty: true, company: '', day: 0, cash: 0, tier: 0, mines: 0 });
      } else {
        out.push({
          index: i,
          empty: false,
          company: r.company,
          day: r.day,
          cash: r.cash,
          /* The ACTIVE slot's machine is the live one; a stored slot is read
           * off its own rig object. Both go through the same arithmetic. */
          tier: (i === active && SM.rig && SM.rig.getMachineTier)
            ? SM.rig.getMachineTier() : tierOfRig(r.rig),
          mines: ownedIn(r)
        });
      }
    }
    return out;
  }

  /** Create a company in `slot`, make it active, and persist. -> the record. */
  function newGame(slot, companyName) {
    try {
      var i = Math.floor(num(slot, -1, -1, A.SAVE_SLOTS - 1));
      if (i < 0) return null;
      if (SM.rig && SM.rig.reset) SM.rig.reset();
      var rec = freshRecord(companyName);
      slots[i] = rec;
      active = i;
      record = rec;
      flush();
      return rec;
    } catch (e) {
      return null;
    }
  }

  /** Make an existing slot active. -> true if it loaded. */
  function load(slot) {
    try {
      var i = Math.floor(num(slot, -1, -1, A.SAVE_SLOTS - 1));
      if (i < 0 || !slots[i]) return false;
      active = i;
      record = slots[i];
      /* The machine is state, and this is the only module that owns its
       * persistence, so installing it belongs here rather than in adv.js. */
      if (SM.rig && SM.rig.applyState) SM.rig.applyState(record.rig);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Wipe a slot. Refuses nothing; the confirm lives in the UI. */
  function erase(slot) {
    try {
      var i = Math.floor(num(slot, -1, -1, A.SAVE_SLOTS - 1));
      if (i < 0) return;
      slots[i] = null;
      if (active === i) { active = -1; record = null; }
      flush();
    } catch (e) { /* never throw */ }
  }

  function getActiveSlot() { return active; }
  function isLoaded() { return !!record; }
  /** The LIVE record. Mutate it, then markDirty(). */
  function get() { return record; }
  /** False when this session is running without persistence. */
  function isAvailable() { return available; }
  /** Why the last write failed, or ''. The prep screen can surface this. */
  function getError() { return lastError; }

  /* =====================================================================
   * WRITING
   * ================================================================== */

  function markDirty() {
    dirty = true;
    if (timer) return;
    try {
      if (typeof setTimeout !== 'function') return;
      timer = setTimeout(function () { timer = 0; flush(); }, DEBOUNCE_MS);
    } catch (e) { timer = 0; }
  }

  /** Write now, synchronously. Call on extraction, purchase, day rollover. */
  function flush() {
    try {
      if (timer) {
        try { clearTimeout(timer); } catch (e) { /* ignore */ }
        timer = 0;
      }
      /* No early-out on `dirty`: erase() and newGame() both flush with the
       * record in whatever state they just left it, and a write is cheap enough
       * that "someone asked" is reason enough.
       *
       * The machine's tiers live in js/rig.js; snapshot them here so no caller
       * has to remember to. */
      if (record && SM.rig && SM.rig.getState) record.rig = SM.rig.getState();

      /* HULL. Repaired into range if it is missing or nonsense, but deliberately
       * NOT pulled from SM.adv.getIntegrity(): newGame() flushes a brand new
       * record BEFORE js/adv.js has adopted it, so a snapshot here would stamp
       * the outgoing company's hull damage onto the incoming one. js/adv.js owns
       * the value and writes it on damage, on repair and on sale — exactly as it
       * owns `cash` and `day`, which are not snapshotted either. */
      if (record && !(typeof record.integrity === 'number' &&
                      record.integrity >= 0 && record.integrity <= 1)) {
        record.integrity = 1;
      }
      dirty = false;
      if (!available) return;
      writeRaw();
    } catch (e) {
      dirty = false;
    }
  }

  /* =====================================================================
   * PER-MINE STATE
   * ================================================================== */

  /** Mine state for `id`, created empty (and unowned) if it has never existed. */
  function mineState(id) {
    if (!record || typeof id !== 'string') return null;
    if (!record.mines) record.mines = {};
    var m = record.mines[id];
    if (!m) {
      /* Created but NOT marked dirty: an all-default entry carries no
       * information, so losing it costs the player nothing and reading the map
       * should not schedule a write. */
      m = blankMineState();
      record.mines[id] = m;
    }
    return m;
  }

  function isOwned(id) {
    /* A price-0 mine is always owned. This is deliberate belt-and-braces: it
     * means a truncated or hand-edited save can never leave a company with no
     * mine it is allowed to enter. */
    if (SM.mines && SM.mines.get) {
      var def = SM.mines.get(id);
      if (def && def.price === 0) return true;
    }
    var m = record && record.mines ? record.mines[id] : null;
    return !!(m && m.owned);
  }

  function setOwned(id, on) {
    var m = mineState(id);
    if (!m) return;
    m.owned = !!on;
    markDirty();
  }

  function ownedCount() { return ownedIn(record); }

  /* --- lift stations ---------------------------------------------------
   * Named levelsOwned/setLevelsOwned rather than get/setLevels on purpose:
   * SM.adv.getLevels() returns the STATION TABLE and these return a COUNT, and
   * two functions one namespace apart with the same name and different units is
   * how a bug gets written twice. */

  /** How many lift levels are bought in this mine. 0 when nothing is loaded. */
  function levelsOwned(id) {
    var m = record && record.mines ? record.mines[id] : null;
    if (!m) return 0;
    var n = Math.floor(num(m.levels, 0, 0, MAX_LEVELS));
    return n;
  }
  /** Persist the count. SM.adv is the only caller; it clamps to the catalogue. */
  function setLevelsOwned(id, n) {
    var m = mineState(id);
    if (!m) return false;
    m.levels = Math.floor(num(n, 0, 0, MAX_LEVELS));
    markDirty();
    return true;
  }

  /* --- rail checkpoints ------------------------------------------------
   * Per LEVEL, so both of these take one. Named railsOwned/setRailsOwned to
   * rhyme with levelsOwned/setLevelsOwned for exactly the same reason: a COUNT
   * and a TABLE must not share a name. */

  /** How many checkpoints are bought on level `L` (1-based) of this mine. */
  function railsOwned(id, L) {
    var m = record && record.mines ? record.mines[id] : null;
    if (!m || !m.rails) return 0;
    var i = Math.floor(num(L, 0, 0, MAX_LEVELS)) - 1;
    if (i < 0 || i >= m.rails.length) return 0;
    return Math.floor(num(m.rails[i], 0, 0, MAX_RAILS));
  }

  /** Persist it. SM.adv is the only caller; it clamps to the catalogue. */
  function setRailsOwned(id, L, n) {
    var m = mineState(id);
    if (!m) return false;
    var i = Math.floor(num(L, 0, 0, MAX_LEVELS)) - 1;
    if (i < 0) return false;
    if (!m.rails || typeof m.rails.length !== 'number') m.rails = [];
    // Dense: pad with zeros rather than leaving holes JSON would write as null.
    while (m.rails.length <= i) m.rails.push(0);
    m.rails[i] = Math.floor(num(n, 0, 0, MAX_RAILS));
    markDirty();
    return true;
  }

  /* --- hull integrity -------------------------------------------------
   * js/adv.js may keep writing record.integrity directly; these exist so that
   * nothing ELSE has to know whether the stored unit is a fraction or a point.
   * Both speak the 0..1 FRACTION that SM.adv.getIntegrity() speaks. To turn one
   * into money, use SM.mines.repairCost(fraction). */

  /** Hull integrity as a 0..1 fraction. 1 when no company is loaded. */
  function getIntegrity() {
    if (!record) return 1;
    return (typeof record.integrity === 'number' &&
            record.integrity >= 0 && record.integrity <= 1) ? record.integrity : 1;
  }
  /** Persist hull integrity. Accepts 0..1; anything else is clamped. */
  function setIntegrity(frac) {
    if (!record) return false;
    record.integrity = num(frac, 1, 0, 1);
    markDirty();
    return true;
  }

  /* --- surveyed world-map regions (js/advui.js) ------------------------ */
  function isSeen(regionKey) {
    return !!(record && record.seen && record.seen[regionKey]);
  }
  function setSeen(regionKey) {
    if (!record || typeof regionKey !== 'string' || !regionKey.length ||
        regionKey.length > MAX_KEY) return false;
    if (!record.seen) record.seen = {};
    if (record.seen[regionKey]) return true;          // already surveyed
    var n = 0;
    for (var k in record.seen) { if (record.seen.hasOwnProperty(k)) n++; }
    if (n >= MAX_SEEN) return false;
    record.seen[regionKey] = 1;
    markDirty();
    return true;
  }

  /* --- convenience writes: the seams other modules actually use -------- */

  /** Store a carve mask for a mine. Accepts a Uint8Array or an RLE string. */
  function storeMask(mineId, u8OrString) {
    var m = mineState(mineId);
    if (!m) return false;
    m.mask = (typeof u8OrString === 'string') ? u8OrString : encodeMask(u8OrString);
    if (m.mask.length > MASK_MAX_CHARS) m.mask = '';
    markDirty();
    return true;
  }
  /** -> Uint8Array or null. `expectedLength` from advterrain.maskDims(). */
  function loadMask(mineId, expectedLength) {
    var m = record && record.mines ? record.mines[mineId] : null;
    if (!m || !m.mask) return null;
    return decodeMask(m.mask, expectedLength);
  }
  /** Replace a mine's dumped-cargo piles. Validated and capped. */
  function setPiles(mineId, piles) {
    var m = mineState(mineId);
    if (!m) return false;
    m.piles = validateMineState({ piles: piles }).piles;
    markDirty();
    return true;
  }
  function getPiles(mineId) {
    var m = record && record.mines ? record.mines[mineId] : null;
    return m ? m.piles : [];
  }
  /** Bump visit count and best depth after a descent. */
  function recordVisit(mineId, depthM) {
    var m = mineState(mineId);
    if (!m) return;
    m.visits++;
    var d = Math.floor(num(depthM, 0, 0, 1e6));
    if (d > m.deepestM) m.deepestM = d;
    if (record) record.stats.runs++;
    markDirty();
  }
  /** Bank a haul into the lifetime stats. */
  function recordHaul(gross) {
    if (!record) return;
    var g = Math.floor(num(gross, 0, 0, MAX_CASH));
    record.stats.hauled += g;
    if (g > record.stats.bestHaul) record.stats.bestHaul = g;
    markDirty();
  }
  function getStats() {
    return record ? record.stats : { hauled: 0, bestHaul: 0, runs: 0 };
  }

  return {
    init: init,
    listSlots: listSlots,
    newGame: newGame,
    load: load,
    erase: erase,
    getActiveSlot: getActiveSlot,
    isLoaded: isLoaded,
    get: get,
    markDirty: markDirty,
    flush: flush,
    mineState: mineState,
    isOwned: isOwned,
    setOwned: setOwned,
    encodeMask: encodeMask,
    decodeMask: decodeMask,

    /* --- Agent-2 additions (documented in the report) ------------------- */
    isAvailable: isAvailable,
    getError: getError,
    getDroppedKeys: getDroppedKeys,
    getIntegrity: getIntegrity,
    setIntegrity: setIntegrity,
    isSeen: isSeen,
    setSeen: setSeen,
    ownedCount: ownedCount,
    levelsOwned: levelsOwned,
    setLevelsOwned: setLevelsOwned,
    railsOwned: railsOwned,
    setRailsOwned: setRailsOwned,
    storeMask: storeMask,
    loadMask: loadMask,
    setPiles: setPiles,
    getPiles: getPiles,
    recordVisit: recordVisit,
    recordHaul: recordHaul,
    getStats: getStats
  };
})();
