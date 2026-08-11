/* =============================================================================
 * SUPERMINE — js/scanner.js                          [OWNER: Agent 3 — GEOLOGY]
 * -----------------------------------------------------------------------------
 * THE MINERAL SCANNER. An upgrade that turns rock into information: it reads ore
 * signatures through walls the machine has not touched yet, and hands the player
 * the decision the whole mode is built around —
 *
 *     GOLD SIGNATURE · 38 m AHEAD          fuel 42%        hold 60% full
 *
 * HOW IT WORKS
 *   Range comes from SM.rig.getScanRange(); 0 means no scanner is installed and
 *   this module does nothing at all — no probe, no draw, no fuel. It costs fuel
 *   to run, so getDraw() reports its consumption to js/adv.js rather than the
 *   information being free.
 *   Contacts come from SM.advterrain.probeAll() — the GENERATOR, not the
 *   particle pool, because the interesting ore is behind rock that has not
 *   streamed in yet.
 *
 * WHY IT IS A ROTATING SWEEP AND NOT A LIST
 *   The instrument holds a cycle: the beam turns at SWEEP_RATE, and a contact
 *   only LIGHTS UP when the beam crosses its bearing, then fades over the rest
 *   of the revolution. That buys three things at once. It is the cheap
 *   implementation (one generator probe per revolution instead of one per step,
 *   which is the performance rule in ADVENTURE.md §5). It is legible without a
 *   legend — you read a bearing from where the mark is, and a distance from how
 *   far out it sits. And it keeps the TENSION: the display is never a complete
 *   picture of the seam, only what the last pass caught, so the player is
 *   deciding on partial information, which is the whole point of the mode. A
 *   minimap of the whole mine would answer the question the game is asking.
 *
 * WHAT IT DRAWS
 *   Called from SM.adv.renderWorld() BEFORE the darkness composite, so marks
 *   read as instrument overlay rather than as lit geometry. A range ring, the
 *   sweep, a bracket per contact, and ONE label: material and distance in
 *   metres on the strongest thing out there.
 * ========================================================================== */

var SM = SM || {};

SM.scanner = (function () {
  'use strict';

  /* ======================================================================
   * ----- Agent-3 tunables -----
   * =================================================================== */

  var SWEEP_RATE = 2.3;        // rad/s. One revolution is ~2.7 s: slow enough
                               // to read as an instrument working, fast enough
                               // that a player who just drilled into a cavern
                               // does not have to wait to be told about it.
  var FADE = 2.9;              // seconds a lit contact takes to go out. Just
                               // over one revolution, so the strongest marks
                               // stay faintly visible between passes and the
                               // weak ones genuinely blink.
  var RING_ALPHA = 0.10;
  var SWEEP_ALPHA = 0.16;
  var MARK_MIN_ALPHA = 0.20;   // a lit mark never goes fully transparent while
                               // it is the best contact — losing the headline
                               // signature mid-decision is just annoying.

  var DRAW_BASE = 0.16;        // fuel units/second at the base scan range
  var DRAW_RANGE_REF = 600;    // ...and the range that figure is quoted at
  var DRAW_SWEEP_SPIKE = 0.5;  // extra fuel, in unit-seconds, per revolution

  var MAX_CONTACTS = 5;        // marks drawn at once, strongest first
  var LABEL_PX = 13;           // label size in SCREEN pixels (counter-scaled)

  /* ================================================================== */

  var A = SM.config.ADV;

  var enabled = false;
  var range = 0;
  var sweep = 0;               // beam bearing, radians, 0 = +x, grows clockwise
  var lastSweep = 0;
  var revs = 0;
  var drawRate = 0;
  var spike = 0;               // decaying extra draw right after a sweep

  /* Contacts are OUR objects, extended in place with the two display fields
   * advterrain does not know about (bearing, lit). advterrain writes into this
   * same array and reuses the slots, so nothing here allocates per sweep. */
  var contacts = [];
  var contactN = 0;
  var best = null;

  var evContact = { matIndex: 0, dist: 0, bearing: 0 };

  function init() { reset(); }

  function reset() {
    contactN = 0;
    best = null;
    sweep = 0;
    lastSweep = 0;
    revs = 0;
    spike = 0;
    drawRate = 0;
    enabled = false;
    range = 0;
  }

  /** False when no scanner is installed, or while we are not in a mine. */
  function isEnabled() { return enabled; }

  function resolveRange() {
    var r = 0;
    if (SM.rig && SM.rig.getScanRange) {
      r = SM.rig.getScanRange();
      if (!(r > 0)) r = 0;
    }
    return r;
  }

  function inMine() {
    if (!SM.advterrain || !SM.advterrain.isActive || !SM.advterrain.isActive()) return false;
    if (SM.adv && SM.adv.isInMine) return SM.adv.isInMine();
    return true;                                  // no adv.js yet: still useful
  }

  function machineX() { return (SM.vehicle && SM.vehicle.getX) ? SM.vehicle.getX() : 0; }
  function machineY() { return (SM.vehicle && SM.vehicle.getY) ? SM.vehicle.getY() : 0; }

  /**
   * Run the generator probe and refresh the contact list. This is the only
   * expensive thing this module does and it happens ONCE PER REVOLUTION, not
   * once per step.
   */
  function doSweep() {
    var px = machineX(), py = machineY();
    contactN = SM.advterrain.probeAll(px, py, range, contacts);

    /* Strongest first, then keep only MAX_CONTACTS of them. A rich shallow
     * layer can genuinely have eight ore bodies inside scan range, and drawing
     * all eight turns a readable instrument into a rash of brackets. Insertion
     * sort over at most eight live slots, once per revolution — and only over
     * the live prefix, because the array keeps its slots from bigger sweeps. */
    for (var s = 1; s < contactN; s++) {
      var v = contacts[s], k = s - 1;
      while (k >= 0 && contacts[k].strength < v.strength) { contacts[k + 1] = contacts[k]; k--; }
      contacts[k + 1] = v;
    }
    if (contactN > MAX_CONTACTS) contactN = MAX_CONTACTS;

    best = null;
    for (var i = 0; i < contactN; i++) {
      var c = contacts[i];
      c.bearing = Math.atan2(c.y - py, c.x - px);
      // Un-lit until the beam reaches it. A contact discovered behind the beam
      // waits for the next pass, which is what makes the sweep mean anything.
      if (c.lit === undefined) c.lit = FADE;
      if (!best || c.strength > best.strength) best = c;
    }
    spike = DRAW_SWEEP_SPIKE;
  }

  /** Force a sweep now — a HUD button, or crossing into a new layer. */
  function ping() {
    if (!enabled) return;
    doSweep();
    // Light everything immediately: a manual ping is the player asking "what is
    // around me RIGHT NOW", and answering with a 2.7-second wipe would be a
    // worse instrument, not a more realistic one.
    for (var i = 0; i < contactN; i++) contacts[i].lit = 0;
    if (best) emitContact(best);
  }

  function emitContact(c) {
    evContact.matIndex = c.matIndex;
    evContact.dist = c.dist;
    evContact.bearing = c.bearing;
    SM.events.emit('scan:contact', evContact);
  }

  /** Shortest signed angle from a to b. */
  function angDiff(a, b) {
    var d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /**
   * ONE FIXED STEP.
   *
   * WHO CALLS THIS. main.js's update order is frozen and predates the scanner,
   * so js/advterrain.js drives it — it is already in the order (through
   * terrain.js's adventure branch) and it is the module that owns the world the
   * scanner reads. It passes a monotonic `token`, one per fixed step.
   *
   * The token exists purely to make a SECOND caller harmless: once a tokenised
   * call has been seen, tokenless ones are ignored, and a repeated token is
   * ignored. If js/adv.js ever also calls scanner.update(dt), the sweep does not
   * quietly run at double speed and burn double fuel — which is exactly the
   * kind of bug that would be blamed on the fuel economy for a week.
   */
  var tokenSeen = false, lastToken = -1;

  function update(dt, token) {
    if (token === undefined) {
      if (tokenSeen) return;
    } else {
      tokenSeen = true;
      if (token === lastToken) return;
      lastToken = token;
    }

    range = resolveRange();
    var was = enabled;
    enabled = range > 0 && inMine();
    if (!enabled) {
      if (was) { contactN = 0; best = null; }
      drawRate = 0;
      return;
    }
    // Freshly installed, or freshly underground: answer immediately rather than
    // making the player wait out a revolution for their first reading.
    if (!was) { sweep = 0; revs = 0; ping(); }

    lastSweep = sweep;
    sweep += SWEEP_RATE * dt;
    if (sweep >= Math.PI * 2) {
      sweep -= Math.PI * 2;
      lastSweep -= Math.PI * 2;
      revs++;
      doSweep();
    }

    /* Light every contact the beam crossed this step, and age the rest. */
    var i, c;
    for (i = 0; i < contactN; i++) {
      c = contacts[i];
      var d0 = angDiff(lastSweep, c.bearing);
      var d1 = angDiff(sweep, c.bearing);
      // The beam passed the bearing when the signed offset flipped from "ahead"
      // to "behind" without wrapping the long way round.
      if (d0 > 0 && d1 <= 0 && d0 < 1.0) {
        var fresh = c.lit >= FADE;
        c.lit = 0;
        if (fresh && c === best) emitContact(c);
      } else {
        c.lit += dt;
      }
    }

    /* Fuel. A constant hotel load plus a spike per revolution, so a scanner is
     * a running cost the player can feel in the burn-rate needle. */
    if (spike > 0) spike -= dt * 2;
    if (spike < 0) spike = 0;
    drawRate = DRAW_BASE * (range / DRAW_RANGE_REF) + spike;
  }

  /* ======================================================================
   * RENDER — world space, before the darkness composite
   * =================================================================== */
  function render(ctx) {
    if (!enabled) return;
    var px = machineX(), py = machineY();
    var scale = (SM.camera && SM.camera.getScale) ? SM.camera.getScale() : 1;
    if (!(scale > 0)) scale = 1;

    ctx.save();

    /* --- the range ring, with a tick every 45 degrees ----------------- */
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = 'rgba(120,255,205,' + RING_ALPHA + ')';
    ctx.beginPath();
    ctx.arc(px, py, range, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    for (var t = 0; t < 8; t++) {
      var a = t * Math.PI / 4;
      var ca = Math.cos(a), sa = Math.sin(a);
      var inner = range * (t % 2 === 0 ? 0.955 : 0.978);
      ctx.moveTo(px + ca * inner, py + sa * inner);
      ctx.lineTo(px + ca * range, py + sa * range);
    }
    ctx.stroke();

    /* --- the sweep: a short leading wedge, not a full radar pie ------- */
    var g = ctx.createLinearGradient(px, py, px + Math.cos(sweep) * range,
                                     py + Math.sin(sweep) * range);
    g.addColorStop(0, 'rgba(120,255,205,0)');
    g.addColorStop(0.75, 'rgba(120,255,205,' + SWEEP_ALPHA + ')');
    g.addColorStop(1, 'rgba(180,255,230,' + (SWEEP_ALPHA * 2.2) + ')');
    ctx.strokeStyle = g;
    ctx.lineWidth = 3 / scale;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(sweep) * range, py + Math.sin(sweep) * range);
    ctx.stroke();

    /* --- contacts ----------------------------------------------------- */
    for (var i = 0; i < contactN; i++) {
      var c = contacts[i];
      var fade = 1 - c.lit / FADE;
      if (c === best && fade < MARK_MIN_ALPHA) fade = MARK_MIN_ALPHA;
      if (fade <= 0.02) continue;
      drawMark(ctx, c, px, py, scale, fade, c === best);
    }

    ctx.restore();
  }

  /**
   * One contact: a bracket at its position, sized by how big the formation is,
   * and a tick on the range ring at its bearing so the direction is readable
   * even when the mark itself is off the lit area.
   */
  function drawMark(ctx, c, px, py, scale, fade, isBest) {
    var col = SM.materials.get(c.matIndex).colors[0];
    var r = 16 + Math.min(40, c.size * 0.22);
    var a = fade * (isBest ? 0.95 : 0.7);

    ctx.strokeStyle = rgba(col, a);
    ctx.lineWidth = (isBest ? 2.4 : 1.6) / scale;

    // Corner brackets — an instrument marking a target, not a game icon.
    var k = r * 0.42;
    ctx.beginPath();
    ctx.moveTo(c.x - r, c.y - r + k); ctx.lineTo(c.x - r, c.y - r); ctx.lineTo(c.x - r + k, c.y - r);
    ctx.moveTo(c.x + r - k, c.y - r); ctx.lineTo(c.x + r, c.y - r); ctx.lineTo(c.x + r, c.y - r + k);
    ctx.moveTo(c.x + r, c.y + r - k); ctx.lineTo(c.x + r, c.y + r); ctx.lineTo(c.x + r - k, c.y + r);
    ctx.moveTo(c.x - r + k, c.y + r); ctx.lineTo(c.x - r, c.y + r); ctx.lineTo(c.x - r, c.y + r - k);
    ctx.stroke();

    // Bearing tick just inside the ring.
    var ca = Math.cos(c.bearing), sa = Math.sin(c.bearing);
    ctx.lineWidth = 4 / scale;
    ctx.beginPath();
    ctx.moveTo(px + ca * (range * 0.90), py + sa * (range * 0.90));
    ctx.lineTo(px + ca * (range * 1.02), py + sa * (range * 1.02));
    ctx.stroke();

    if (!isBest) return;

    /* --- the one label ------------------------------------------------
     * Counter-scaled so it is a fixed number of SCREEN pixels: world-space
     * text on a camera that zooms is unreadable at one end of the range and
     * absurd at the other. */
    var m = SM.materials.get(c.matIndex);
    var metres = Math.round(c.dist * A.METERS_PER_UNIT);
    var label = m.name.toUpperCase() + '  ' + metres + ' m';
    ctx.save();
    ctx.translate(c.x, c.y - r - 8 / scale);
    ctx.scale(1 / scale, 1 / scale);
    ctx.font = 'bold ' + LABEL_PX + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    var w = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(6,14,12,' + (0.55 * fade) + ')';
    ctx.fillRect(-w * 0.5 - 6, -LABEL_PX - 4, w + 12, LABEL_PX + 7);
    ctx.fillStyle = rgba(col, fade);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  function rgba(hex, a) {
    var r = 255, g = 255, b = 255;
    if (hex.charAt(0) === '#' && hex.length >= 7) {
      r = parseInt(hex.substr(1, 2), 16);
      g = parseInt(hex.substr(3, 2), 16);
      b = parseInt(hex.substr(5, 2), 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }

  /* ======================================================================
   * READ-ONLY SURFACE for js/advhud.js
   * =================================================================== */
  /** LIVE array. Only the first getContactCount() entries are valid. */
  function getContacts() { return contacts; }
  function getContactCount() { return contactN; }
  /** The headline contact, or null. REUSED — read it, do not stash it. */
  function getBest() { return contactN ? best : null; }
  /** Fuel units per second this instrument is currently drawing. */
  function getDraw() { return drawRate; }

  return {
    init: init,
    reset: reset,
    update: update,
    render: render,
    isEnabled: isEnabled,
    ping: ping,
    getContacts: getContacts,
    getBest: getBest,
    getDraw: getDraw,

    /* --- additions beyond the stub ------------------------------------- */
    getContactCount: getContactCount,
    /** 0..1 through the current revolution — for a HUD sweep indicator. */
    getSweepPhase: function () { return sweep / (Math.PI * 2); },
    getRange: function () { return range; }
  };
})();
