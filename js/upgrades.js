/* =============================================================================
 * SUPERMINE — js/upgrades.js                       [OWNER: Agent 2 — gameplay]
 * -----------------------------------------------------------------------------
 * Upgrade delivery. Three flavours, all placed in the world by level.js so the
 * action is never interrupted:
 *
 *   1. PAIRED GATES   two arches at the same depth, left and right, each
 *                     offering a different upgrade. Drive through one; the
 *                     other slams shut. This is the route choice.
 *   2. STATIONS       a gantry spanning the whole lane. Unmissable, used for
 *                     the guaranteed beats of the progression curve.
 *   3. AUTO TRANSFORMS level.js calls trigger() on a collection threshold.
 *
 * >>> CAMERA AUTHORITY <<<
 * This module NO LONGER touches SM.camera.setZoomTarget(). Zoom is derived by
 * camera.js from SM.vehicle.getWidth() and level progress (Agent 3). The only
 * camera call left here is a small shake() on a gate pass.
 *
 * Public API
 *   SM.upgrades.init() / reset() / update(dt) / render(ctx)
 *   SM.upgrades.addGate(spec)  {id, upgradeId, x, y, width?, label?,
 *                               description?, kind?, pairId?, tone?}
 *   SM.upgrades.getGates()     live array — terrain.js reads it to carve openings
 *   SM.upgrades.clearGates()
 *   SM.upgrades.trigger(id)    apply an upgrade directly (no gate)
 *   SM.upgrades.getMultiplier()
 *
 * Events emitted
 *   gate:passed        {id, upgradeId, x, y}
 *   gate:missed        {id, upgradeId, x, y}
 *   upgrade:applied    {id, title, description}
 *   multiplier:changed {value}
 * ========================================================================== */

var SM = SM || {};

SM.upgrades = (function () {
  'use strict';

  /* ----- Agent-2 tunables --------------------------------------------- */
  var PILLAR_W = 26;
  var PILLAR_H = 96;
  var ARCH_H = 30;
  var PASS_FADE = 1.4;           // seconds of "gate consumed" animation
  var APPROACH_HINT = 760;       // start drawing chevrons this far out
  var GATE_SHAKE = 14;           // small: camera trauma saturates fast
  var STATION_SHAKE = 20;

  var C = SM.config;
  var TAU = Math.PI * 2;

  var gates = [];
  var prevFrontY = 0;
  var animTime = 0;
  var lastMultiplier = 1;

  var evGate = { id: '', upgradeId: '', x: 0, y: 0 };
  var evUpgrade = { id: '', title: '', description: '' };
  var evMult = { value: 1 };

  /* ------------------------------------------------------------------ */

  function init() { reset(); }

  function reset() {
    gates.length = 0;
    animTime = 0;
    prevFrontY = C.START_Y;
    lastMultiplier = 1;
    evMult.value = 1;
    SM.events.emit('multiplier:changed', evMult);
  }

  function clearGates() { gates.length = 0; }

  /**
   * Place a gate (or a station) in the world.
   * @param spec {id, upgradeId, x, y, width?, label?, description?,
   *              kind?('gate'|'station'), pairId?, tone?('safe'|'risk')}
   */
  function addGate(spec) {
    var eff = SM.vehicle.getUpgradeEffect(spec.upgradeId);
    var station = spec.kind === 'station';
    gates.push({
      id: spec.id,
      upgradeId: spec.upgradeId,
      kind: station ? 'station' : 'gate',
      pairId: spec.pairId || '',
      tone: spec.tone || (station ? 'station' : 'safe'),
      x: spec.x || 0,
      y: spec.y,
      width: spec.width || (station ? C.LANE_HALF_WIDTH * 2 - 24 : C.GATE_WIDTH),
      label: spec.label || (eff && eff.title) || 'UPGRADE',
      description: spec.description || (eff && eff.description) || '',
      passed: false,
      missed: false,
      rejected: false,           // sibling of a chosen pair
      resolved: false,           // pair already decided this run
      t: 0                       // pass / reject animation timer
    });
    return gates[gates.length - 1];
  }

  function getGates() { return gates; }

  /** Apply an upgrade with no gate involved (auto-transform, debug, ...). */
  function trigger(upgradeId) {
    var eff = SM.vehicle.applyUpgrade(upgradeId);
    if (!eff) return false;
    evUpgrade.id = upgradeId;
    evUpgrade.title = eff.title || upgradeId;
    evUpgrade.description = eff.description || '';
    SM.events.emit('upgrade:applied', evUpgrade);

    var m = SM.vehicle.getValueMultiplier();
    if (m !== lastMultiplier) {
      lastMultiplier = m;
      evMult.value = m;
      SM.events.emit('multiplier:changed', evMult);
    }
    if (SM.camera) SM.camera.shake(GATE_SHAKE);
    return true;
  }

  function getMultiplier() { return SM.vehicle.getValueMultiplier(); }

  /* ------------------------------------------------------------------ */

  function passGate(g, shake) {
    g.passed = true;
    g.resolved = true;
    g.t = 0;
    evGate.id = g.id;
    evGate.upgradeId = g.upgradeId;
    evGate.x = g.x;
    evGate.y = g.y;
    SM.events.emit('gate:passed', evGate);
    trigger(g.upgradeId);
    if (SM.camera) SM.camera.shake(shake);
  }

  function missGate(g) {
    if (g.missed) return;
    g.missed = true;
    g.resolved = true;
    g.t = 0;
    evGate.id = g.id;
    evGate.upgradeId = g.upgradeId;
    evGate.x = g.x;
    evGate.y = g.y;
    SM.events.emit('gate:missed', evGate);
  }

  function update(dt) {
    animTime += dt;

    var vx = SM.vehicle.getX();
    var frontY = SM.vehicle.getBladeFrontY();
    var halfSpan = SM.vehicle.getWidth() * 0.5;

    var i, j, g, h, d;

    for (i = 0; i < gates.length; i++) {
      g = gates[i];
      if (g.passed || g.rejected || g.missed) { g.t += dt; continue; }
      if (g.resolved) continue;

      // Crossing test on the blade line (forward is -y).
      if (!(prevFrontY > g.y && frontY <= g.y)) continue;

      /* --- resolve the whole pair in one go ---------------------------
       * Both halves of a pair cross on the same step. Picking "whichever
       * overlaps" would let a very wide machine claim both, so the nearest
       * one wins and the sibling is closed off.
       * --------------------------------------------------------------- */
      var best = g;
      var bestD = Math.abs(vx - g.x);
      if (g.pairId) {
        for (j = 0; j < gates.length; j++) {
          h = gates[j];
          if (h === g || h.pairId !== g.pairId || h.resolved) continue;
          d = Math.abs(vx - h.x);
          if (d < bestD) { bestD = d; best = h; }
        }
      }

      var reach = best.width * 0.5 + halfSpan * 0.35;
      if (bestD <= reach) {
        passGate(best, best.kind === 'station' ? STATION_SHAKE : GATE_SHAKE);
      } else {
        missGate(best);
      }

      // Close every other member of the pair.
      if (g.pairId) {
        for (j = 0; j < gates.length; j++) {
          h = gates[j];
          if (h === best || h.pairId !== g.pairId || h.resolved) continue;
          h.rejected = true;
          h.resolved = true;
          h.t = 0;
        }
      }
    }
    prevFrontY = frontY;

    // Recycle gates far behind so the array cannot grow forever.
    var cutoff = SM.vehicle.getY() + C.STREAM_BEHIND + 600;
    for (var k = gates.length - 1; k >= 0; k--) {
      if (gates[k].y > cutoff) gates.splice(k, 1);
    }
  }

  /* =====================================================================
   * RENDER (world space, drawn between the particles and the vehicle)
   * ================================================================== */
  function toneColor(g) {
    if (g.kind === 'station') return '255,190,60';
    return g.tone === 'risk' ? '255,120,90' : '120,230,255';
  }

  function render(ctx) {
    if (!gates.length) return;
    var view = SM.camera.getViewBounds();
    var vy = SM.vehicle.getY();

    for (var i = 0; i < gates.length; i++) {
      var g = gates[i];
      if (g.y < view.minY - 240 || g.y > view.maxY + 240) continue;

      var fade = 1;
      var burst = 0;
      if (g.passed || g.rejected) {
        fade = 1 - Math.min(1, g.t / PASS_FADE);
        burst = Math.min(1, g.t / 0.35);
        if (fade <= 0) continue;
      }

      var col = toneColor(g);
      var half = g.width * 0.5;
      var station = g.kind === 'station';

      ctx.save();
      ctx.globalAlpha = fade;

      /* --- approach chevrons on the ground --------------------------- */
      var dist = g.y - vy;                                  // negative = ahead
      if (!g.passed && !g.rejected && dist > -APPROACH_HINT && dist < 0) {
        var pulse = (animTime * 1.6) % 1;
        ctx.strokeStyle = 'rgba(' + col + ',0.45)';
        ctx.lineWidth = 5;
        var chevHalf = station ? 260 : half * 0.55;
        for (var c = 0; c < 3; c++) {
          var cy = g.y + 70 + c * 46 + pulse * 46;
          var a = 0.5 - c * 0.14;
          ctx.globalAlpha = fade * a;
          ctx.beginPath();
          ctx.moveTo(g.x - chevHalf, cy + 16);
          ctx.lineTo(g.x, cy);
          ctx.lineTo(g.x + chevHalf, cy + 16);
          ctx.stroke();
        }
        ctx.globalAlpha = fade;
      }

      /* --- light beam across the opening ----------------------------- */
      var beamA = (g.passed || g.rejected)
        ? 0.5 * (1 - burst)
        : 0.28 + 0.12 * Math.sin(animTime * 4);
      if (g.rejected) beamA *= 0.4;
      var bg = ctx.createLinearGradient(0, g.y - 26, 0, g.y + 26);
      bg.addColorStop(0, 'rgba(' + col + ',0)');
      bg.addColorStop(0.5, 'rgba(' + col + ',' + beamA.toFixed(3) + ')');
      bg.addColorStop(1, 'rgba(' + col + ',0)');
      ctx.fillStyle = bg;
      ctx.fillRect(g.x - half, g.y - 26, g.width, 52);

      /* --- pillars ---------------------------------------------------- */
      for (var s = -1; s <= 1; s += 2) {
        var px = g.x + s * half;
        var kick = g.passed ? burst * 26 * s : 0;
        ctx.save();
        ctx.translate(px + kick, g.y);

        ctx.fillStyle = g.rejected ? '#242830' : '#33393f';
        ctx.fillRect(-PILLAR_W * 0.5, -PILLAR_H * 0.5, PILLAR_W, PILLAR_H);
        ctx.strokeStyle = '#12151a';
        ctx.lineWidth = 3;
        ctx.strokeRect(-PILLAR_W * 0.5, -PILLAR_H * 0.5, PILLAR_W, PILLAR_H);

        ctx.fillStyle = g.rejected ? 'rgba(150,120,60,0.4)' : 'rgba(255,190,40,0.9)';
        for (var yy = -PILLAR_H * 0.5 + 6; yy < PILLAR_H * 0.5 - 8; yy += 18) {
          ctx.fillRect(-PILLAR_W * 0.5 + 4, yy, PILLAR_W - 8, 7);
        }

        // beacon
        var on = ((animTime * 3) % 1) < 0.5 && !g.rejected;
        ctx.fillStyle = on ? 'rgba(' + col + ',0.95)' : 'rgba(30,60,80,0.9)';
        ctx.beginPath();
        ctx.arc(0, -PILLAR_H * 0.5 - 6, 6, 0, TAU);
        ctx.fill();
        if (on) {
          ctx.fillStyle = 'rgba(' + col + ',0.20)';
          ctx.beginPath();
          ctx.arc(0, -PILLAR_H * 0.5 - 6, 18, 0, TAU);
          ctx.fill();
        }
        ctx.restore();
      }

      /* --- station gantry legs ---------------------------------------- */
      if (station) {
        ctx.strokeStyle = 'rgba(255,190,60,0.55)';
        ctx.lineWidth = 4;
        for (var lx = g.x - half + 90; lx < g.x + half; lx += 150) {
          ctx.beginPath();
          ctx.moveTo(lx, g.y - PILLAR_H * 0.5);
          ctx.lineTo(lx, g.y + PILLAR_H * 0.5);
          ctx.stroke();
        }
      }

      /* --- arch + label ------------------------------------------------ */
      var archY = g.y - PILLAR_H * 0.5 - ARCH_H - 6;
      ctx.fillStyle = station ? '#31281c' : '#262b31';
      ctx.fillRect(g.x - half - PILLAR_W * 0.5, archY, g.width + PILLAR_W, ARCH_H);
      ctx.strokeStyle = '#12151a';
      ctx.lineWidth = 3;
      ctx.strokeRect(g.x - half - PILLAR_W * 0.5, archY, g.width + PILLAR_W, ARCH_H);

      var text;
      if (g.passed) text = 'INSTALLED';
      else if (g.rejected) text = 'CLOSED';
      else if (g.missed) text = 'MISSED';
      else text = g.label;

      ctx.fillStyle = g.passed ? 'rgba(150,255,190,0.95)'
        : (g.rejected || g.missed) ? 'rgba(180,180,190,0.7)'
        : 'rgba(255,225,120,0.95)';
      ctx.font = 'bold 17px ui-sans-serif, system-ui, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, g.x, archY + ARCH_H * 0.5);

      // Risk-route tag, so the choice reads before you commit to a side.
      if (!g.passed && !g.rejected && !g.missed && g.pairId) {
        ctx.font = 'bold 12px ui-sans-serif, system-ui, Arial, sans-serif';
        ctx.fillStyle = 'rgba(' + col + ',0.8)';
        ctx.fillText(g.tone === 'risk' ? 'HARD ROUTE' : 'SAFE ROUTE', g.x, archY - 12);
      }

      /* --- pass shockwave ---------------------------------------------- */
      if (g.passed && burst < 1) {
        ctx.strokeStyle = 'rgba(255,255,255,' + (1 - burst).toFixed(3) + ')';
        ctx.lineWidth = 6 * (1 - burst) + 1;
        ctx.beginPath();
        ctx.arc(g.x, g.y, 40 + burst * 300, 0, TAU);
        ctx.stroke();
      }

      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  return {
    init: init,
    reset: reset,
    update: update,
    render: render,
    addGate: addGate,
    getGates: getGates,
    clearGates: clearGates,
    trigger: trigger,
    getMultiplier: getMultiplier
  };
})();
