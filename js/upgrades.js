/* =============================================================================
 * SUPERMINE — js/upgrades.js                       [OWNER: Agent 2 — gameplay]
 * -----------------------------------------------------------------------------
 * Upgrade delivery. Three flavours, all placed in the world by level.js so the
 * action is never interrupted:
 *
 *   1. PAIRED GATES   two arches at the same depth, left and right. In the
 *                     TIME ATTACK one side is always a `time_10` gate
 *                     (+10 SECONDS on the clock) and the other is a machine
 *                     upgrade. Drive through one; the other slams shut.
 *   2. STATIONS       a gantry spanning the whole lane. Unmissable, upgrades
 *                     only — the guaranteed beats of the progression curve.
 *   3. AUTO TRANSFORMS level.js calls trigger() on a collection threshold.
 *
 * >>> TIME GATES <<<
 * `time_10` is a PSEUDO-upgrade. It is not in vehicle.js's UPGRADE_EFFECTS,
 * so SM.vehicle.applyUpgrade('time_10') returns null and it can never show up
 * in getOwnedUpgrades() or getUpgradeCount(). trigger() routes it to
 * SM.level.addTime() and then emits the ordinary `upgrade:applied` event, so
 * the toast / sound / flash keep working with no special-casing downstream.
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

  /* --- TIME REWARDS ----------------------------------------------------
   * A `time_10` gate is NOT a machine upgrade. It never reaches vehicle.js:
   * it does not exist in UPGRADE_EFFECTS, so it can never appear in
   * getOwnedUpgrades() nor move getUpgradeCount(). It pays the clock instead,
   * and only borrows the `upgrade:applied` event so the existing toast works.
   *
   * `seconds` mirrors TIME_BONUS in level.js — keep the two in step.
   * ------------------------------------------------------------------ */
  var TIME_REWARDS = {
    time_10: {
      seconds: 10,
      title: '+10 SECONDS',
      description: 'Ten more seconds in the mine.',
      label: '+10 SEC'
    }
  };
  // Time gates read as a CLOCK, not as power. Green is the only hue not
  // already spoken for (amber = station, cyan = safe route, red = hard route)
  // and it is the universal "you just bought more time" colour.
  var TIME_TONE = '90,255,150';
  var TIME_CLOCK_R = 11;         // radius of the clock glyph over the arch

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
    // getUpgradeEffect() returns null for a time id, so without this the arch
    // would fall through to the generic 'UPGRADE' label and lie to the player.
    var tr = TIME_REWARDS[spec.upgradeId] || null;
    var station = spec.kind === 'station';
    gates.push({
      id: spec.id,
      upgradeId: spec.upgradeId,
      kind: station ? 'station' : 'gate',
      pairId: spec.pairId || '',
      // `tone` still records which SIDE of the pair this is (level.js sets it,
      // and the terrain really is harder on the right); `isTime` overrides how
      // it is drawn, so a +time gate looks identical on either side.
      tone: spec.tone || (station ? 'station' : 'safe'),
      isTime: !!tr,
      x: spec.x || 0,
      y: spec.y,
      width: spec.width || (station ? C.LANE_HALF_WIDTH * 2 - 24 : C.GATE_WIDTH),
      label: spec.label || (tr && tr.label) || (eff && eff.title) || 'UPGRADE',
      description: spec.description ||
                   (tr && tr.description) || (eff && eff.description) || '',
      passed: false,
      missed: false,
      rejected: false,           // sibling of a chosen pair
      resolved: false,           // pair already decided this run
      t: 0                       // pass / reject animation timer
    });
    return gates[gates.length - 1];
  }

  function getGates() { return gates; }

  /**
   * Bank a time reward. Routes to the clock instead of the machine, but still
   * emits `upgrade:applied` so the toast, the sound and the flash all work
   * with no special-casing anywhere in presentation.
   */
  function grantTime(id, tr) {
    if (!SM.level || !SM.level.addTime) return false;
    // Refused when the run is already over (the halting rig can still coast
    // through a gate on the step the clock hit zero) — no ghost toast then.
    if (!SM.level.addTime(tr.seconds)) return false;

    evUpgrade.id = id;
    evUpgrade.title = tr.title;
    evUpgrade.description = tr.description;
    SM.events.emit('upgrade:applied', evUpgrade);
    if (SM.camera) SM.camera.shake(GATE_SHAKE);
    return true;
  }

  /** Apply an upgrade with no gate involved (auto-transform, debug, ...). */
  function trigger(upgradeId) {
    var tr = TIME_REWARDS[upgradeId];
    if (tr) return grantTime(upgradeId, tr);

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
    // Time first: the reward, not the side of the lane, is what has to read
    // from 700 units away while you are still deciding which arch to aim at.
    if (g.isTime) return TIME_TONE;
    if (g.kind === 'station') return '255,190,60';
    return g.tone === 'risk' ? '255,120,90' : '120,230,255';
  }

  /** Clock face over the arch. Two arcs and two hands — the cheapest shape
   *  that says "time" without a font the player has to stop and read. */
  function drawClock(ctx, cx, cy, col, spin) {
    ctx.strokeStyle = 'rgba(' + col + ',0.95)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, TIME_CLOCK_R, 0, TAU);
    ctx.stroke();
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - TIME_CLOCK_R * 0.62);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(spin) * TIME_CLOCK_R * 0.78,
               cy - Math.cos(spin) * TIME_CLOCK_R * 0.78);
    ctx.stroke();
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
      ctx.fillStyle = g.isTime ? '#1b2a22' : station ? '#31281c' : '#262b31';
      ctx.fillRect(g.x - half - PILLAR_W * 0.5, archY, g.width + PILLAR_W, ARCH_H);
      ctx.strokeStyle = '#12151a';
      ctx.lineWidth = 3;
      ctx.strokeRect(g.x - half - PILLAR_W * 0.5, archY, g.width + PILLAR_W, ARCH_H);

      var text;
      if (g.passed) text = g.isTime ? '+10 SEC' : 'INSTALLED';
      else if (g.rejected) text = 'CLOSED';
      else if (g.missed) text = 'MISSED';
      else text = g.label;

      ctx.fillStyle = g.passed ? 'rgba(150,255,190,0.95)'
        : (g.rejected || g.missed) ? 'rgba(180,180,190,0.7)'
        : g.isTime ? 'rgba(' + TIME_TONE + ',0.98)'
        : 'rgba(255,225,120,0.95)';
      ctx.font = 'bold 17px ui-sans-serif, system-ui, Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, g.x, archY + ARCH_H * 0.5);

      // Route tag, so the choice reads before you commit to a side. A time
      // gate says TIME instead: which half of the lane it happens to sit on
      // is irrelevant once you know it pays the clock.
      if (!g.passed && !g.rejected && !g.missed && g.pairId) {
        ctx.font = 'bold 12px ui-sans-serif, system-ui, Arial, sans-serif';
        ctx.fillStyle = 'rgba(' + col + ',0.8)';
        ctx.fillText(
          g.isTime ? 'TIME' : (g.tone === 'risk' ? 'HARD ROUTE' : 'SAFE ROUTE'),
          g.x, archY - 12);
        if (g.isTime) {
          drawClock(ctx, g.x, archY - 34, col, animTime * 2.4);
        }
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
