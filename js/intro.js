/* =============================================================================
 * SUPERMINE — js/intro.js                         the three-second sting
 * -----------------------------------------------------------------------------
 * The rig comes down out of the night, bites into the ground and bores
 * straight down: dirt, rubble, stone, granite and obsidian stream up past it,
 * spoil sprays off the bit in the colour of whatever it is chewing, and ore
 * glints in the walls on the way by. Two seconds in, the bit strikes a gold
 * seam, the screen kicks, the rock goes dark and SUPERMINE punches in, in the
 * menu's own white-on-brass glow. Then the wordmark slides and shrinks onto
 * the exact spot of the real one on the start screen while the dark thins
 * away, so the hand-off is the name landing in its place rather than one
 * picture swapped for another.
 *
 * Every colour is the game's: the strata are js/materials.js's base colours,
 * the bit and the hazard band are style.css's --sm-gold and --sm-hazard, the
 * shaft is the game's tunnel black (#0a0705). The only word is the game's own
 * name, which hub §2 leaves untranslated, so there is nothing for i18n.js.
 *
 * WHAT IT MAY NOT DO
 *   - Cost anyone a run (hub §1). It only ever plays at page load, over the
 *     start screen, and any tap or key skips straight to the hand-off.
 *   - Let the skipping press through. Keys are swallowed by a CAPTURE-phase
 *     listener on window. input.js and ui.js both listen on window in the
 *     BUBBLE phase, and a key event is dispatched to the focused element, so
 *     window's capture listeners run before anything else on the path no
 *     matter who registered first — the press that skips can never also be
 *     the start screen's Escape (the way out to the arcade) or Enter. It is
 *     loaded async from the top of <body> anyway, as NeonFox's is, so it is
 *     also first in line should anybody ever add a capture listener.
 *     A tap lands on the curtain itself, which covers every button, the
 *     corner plates (z-index 30) included.
 *   - Delay the game. It is a curtain over the page, not a gate: the
 *     fourteen SM scripts load and main.js boots underneath while it plays.
 *     index.html is frozen apart from its one async <script> tag, and nothing
 *     in SM knows this file exists.
 *   - Play for someone who has asked for less motion. prefers-reduced-motion
 *     means the script does nothing at all.
 *   - Make a sound. The audio context does not exist until a mode card is
 *     tapped, and a sting is no reason to change that.
 *
 * Self-contained, classic, importing nothing and touching no SM global: if
 * anything else fails, the curtain must still lift. Every frame runs inside a
 * try, a hard timeout removes the curtain whatever happens, and a failure of
 * this file leaves the game exactly as it was without it.
 *
 * Canvas 2D, devicePixelRatio capped at 2, strata and ore laid out once, a
 * fixed debris pool, and no allocation in the frame loop (hub §10). The
 * wordmark is measured once at a 100px reference size and drawn by scaling
 * the transform, so no font string is built per frame.
 * ========================================================================== */
(function () {
  'use strict';

  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {
    /* No matchMedia: play it. */
  }

  /* --- palette, copied rather than read, because this file reads nothing --- */
  var BG = '#0b0a0d';        // --sm-bg
  var NIGHT = '#05070a';     // the top of the menu's metal gradients
  var SHAFT = '#0a0705';     // the tunnel the rig leaves behind it
  var GOLD = '#ffc21f';      // --sm-gold
  var GOLD_DARK = '#c9911a'; // gold's shadow in materials.js
  var GOLD_HOT = '#fff0a8';  // --sm-gold-hot
  var HAZARD_A = '#f0b31b';  // --sm-hazard's two stripes
  var HAZARD_B = '#171512';
  var METAL = '#262a32';     // the rig's body, from the HUD plates
  var METAL_HI = '#5a636f';

  // Strata top to bottom: dirt, rubble, stone, granite, obsidian, and round
  // again a shade darker — the deeper you go the darker the game gets.
  var STRATA = ['#7c5a3a', '#8b8175', '#6d737c', '#5a636f', '#3b3350',
                '#553c26', '#5c554c', '#484d55', '#333a45', '#1b1728'];
  // Ore glints: gold, crystal, emerald, iron, voidstone, starcore.
  var ORES = ['#ffcb31', '#48bcff', '#33dd80', '#d6e2ec', '#c46bff', '#ff7ad9'];

  /* --- the timeline, in milliseconds --------------------------------------
   * ENTER: the rig drops from above the screen onto the surface.
   * DIG..STRIKE: the ground streams up past it, accelerating.
   * STRIKE: the bit hits the gold seam — flash and kick.
   * LOGO_IN: the wordmark punches in over LOGO_MS, and the rock goes dark
   * behind it by DARK. LAND starts the hand-off, which takes LAND_MS (or
   * SKIP_MS when the player skipped). */
  var ENTER = 520;
  var DIG = 420;
  var STRIKE = 1500;
  var LOGO_IN = 1540;
  var LOGO_MS = 460;
  var DARK = 2300;
  var LAND = 2600;
  var LAND_MS = 650;
  var SKIP_MS = 380;

  // How far the ground scrolls by STRIKE, in screen heights, and where the
  // surface starts. The strata stack must cover both plus one screen.
  var SURFACE = 0.34;
  var DEPTH = 2.7;
  var BAND_H = 0.46;
  var EDGE = 16; // points along each band's jagged top edge

  var WORD = 'SUPERMINE';
  var SPACING = 0.15; // letter-spacing as a fraction of the font size, as in style.css
  var FONT = '900 100px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  var canvas = document.createElement('canvas');
  canvas.id = 'intro';
  canvas.setAttribute('aria-hidden', 'true');
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  /* --- the ground, laid out once in screen-height units ------------------ */
  var bandTop = new Float32Array(STRATA.length);
  var bandEdge = new Float32Array(STRATA.length * EDGE);
  for (var b = 0; b < STRATA.length; b++) {
    bandTop[b] = SURFACE + b * BAND_H;
    for (var k = 0; k < EDGE; k++) {
      // The surface itself is nearly flat; the seams below it are not.
      var rough = b === 0 ? 0.006 : 0.035;
      bandEdge[b * EDGE + k] = (Math.random() * 2 - 1) * rough;
    }
  }
  var ORE_N = 46;
  var ore = new Float32Array(ORE_N * 4); // x (0..1), depth (H units), size, colour
  for (var o = 0; o < ORE_N; o++) {
    ore[o * 4] = Math.random();
    ore[o * 4 + 1] = SURFACE + 0.08 + Math.random() * (STRATA.length * BAND_H - 0.1);
    ore[o * 4 + 2] = 0.5 + Math.random() * 0.8;
    ore[o * 4 + 3] = Math.floor(Math.random() * ORES.length);
  }

  /* --- spoil off the bit: a fixed pool, recycled ------------------------- */
  var DEB_N = 80;
  var deb = new Float32Array(DEB_N * 6); // x, y, vx, vy, life, band
  var debNext = 0;

  /* --- the wordmark, measured once at 100px ------------------------------ */
  var glyphW = new Float32Array(WORD.length);
  var wordW100 = 0; // ink width at 100px, spacing included

  var W = 0, H = 0, dpr = 1;
  var unit = 0;     // the rig's size, from the short side of the screen

  function size() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    unit = Math.max(40, Math.min(Math.min(W, H) * 0.11, 84));
  }

  function measure() {
    ctx.font = FONT;
    wordW100 = 0;
    for (var i = 0; i < WORD.length; i++) {
      glyphW[i] = ctx.measureText(WORD.charAt(i)).width;
      wordW100 += glyphW[i];
    }
    wordW100 += SPACING * 100 * (WORD.length - 1);
  }

  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function easeInOut(x) { return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  function easeOutBack(x) {
    var c = 1.7;
    return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2);
  }

  // Ground travelled, in screen heights: slow as the bit bites, then it
  // finds its feet and runs, then it stops dead on the seam.
  function depthAt(t) {
    var p = clamp01((t - DIG) / (STRIKE - DIG));
    return DEPTH * p * p * (1.6 - 0.6 * p);
  }

  // The kick: one at the strike, a smaller one when the name slams down.
  function shakeAt(t) {
    var a = t - STRIKE;
    var s = a > 0 && a < 380 ? (1 - a / 380) * 9 : 0;
    var c = t - (LOGO_IN + LOGO_MS * 0.45);
    if (c > 0 && c < 300) s += (1 - c / 300) * 6;
    return s;
  }

  /* --- where the wordmark lives on the start screen ----------------------
   * Asked at hand-off, never earlier: ui.js builds the menu at runtime, so
   * when this script starts there is nothing to ask about. Missing, or the
   * menu already dismissed (.sm-start-off), and the name simply fades. */
  var target = null;
  var realLogo = null;
  function findTarget() {
    var el = document.querySelector('.sm-start-logo');
    if (!el || el.closest('.sm-start-off')) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    var cs = window.getComputedStyle(el);
    var fs = parseFloat(cs.fontSize);
    if (!(fs > 0)) return null;
    var ls = parseFloat(cs.letterSpacing);
    realLogo = el;
    // The real one steps aside so the flying one lands on an empty spot; it
    // is given back the moment the curtain goes.
    el.style.visibility = 'hidden';
    // text-indent pays back the trailing spacing, so the ink is centred on
    // the box; line-height is 1, so the box's middle is the text's middle.
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      size: fs,
      spacing: ls > 0 ? ls / fs : SPACING
    };
  }

  var t0 = 0;
  var landAt = LAND;
  var landMs = LAND_MS;
  var done = false;
  var raf = 0;

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', size);
    if (realLogo) realLogo.style.visibility = '';
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  function skip() {
    var now = performance.now() - t0;
    if (now >= landAt) return;
    landAt = now;
    landMs = SKIP_MS;
  }

  function onKey(e) {
    // Skip, and let the press go no further: see the header.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.repeat) skip();
  }

  /* --- drawing ---------------------------------------------------------- */

  function drawGround(d, rigX, tipY) {
    // Night above the surface.
    ctx.fillStyle = NIGHT;
    ctx.fillRect(0, 0, W, H);
    var step = W / (EDGE - 1);
    for (var b = 0; b < STRATA.length; b++) {
      var top = (bandTop[b] - d) * H;
      var next = b + 1 < STRATA.length ? (bandTop[b + 1] - d) * H : H + 40;
      if (next < -0.1 * H || top > H + 0.1 * H) continue;
      // Each band runs from its own jagged top to the next one's, so no two
      // overlap and a partial fade shows no seams.
      ctx.fillStyle = STRATA[b];
      ctx.beginPath();
      ctx.moveTo(0, top + bandEdge[b * EDGE] * H);
      for (var k = 1; k < EDGE; k++) ctx.lineTo(k * step, top + bandEdge[b * EDGE + k] * H);
      if (b + 1 < STRATA.length) {
        for (var j = EDGE - 1; j >= 0; j--) ctx.lineTo(j * step, next + bandEdge[(b + 1) * EDGE + j] * H);
      } else {
        ctx.lineTo(W, next);
        ctx.lineTo(0, next);
      }
      ctx.closePath();
      ctx.fill();
    }
    // Ore in the walls: a diamond each, twinkling as it streams past.
    var s0 = unit * 0.13;
    for (var o = 0; o < ORE_N; o++) {
      var y = (ore[o * 4 + 1] - d) * H;
      if (y < -20 || y > H + 20) continue;
      var x = ore[o * 4] * W;
      var r = s0 * ore[o * 4 + 2];
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin(y * 0.05 + o);
      ctx.fillStyle = ORES[ore[o * 4 + 3]];
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // The shaft: everything above the bit has been dug out.
    var surf = (SURFACE - d) * H;
    var sw = unit * 0.92;
    var sTop = Math.max(surf, -10);
    if (tipY - unit * 0.4 > sTop) {
      ctx.fillStyle = SHAFT;
      ctx.fillRect(rigX - sw / 2, sTop, sw, tipY - unit * 0.4 - sTop);
    }
  }

  function drawRig(x, tipY, t, digging) {
    var bw = unit;
    var bitH = unit * 0.85;
    var bodyH = unit * 0.9;
    var bodyY = tipY - bitH - bodyH;
    // Body: dark plate, a lit top edge, and a hazard band across its waist.
    ctx.fillStyle = METAL;
    ctx.fillRect(x - bw / 2, bodyY, bw, bodyH);
    ctx.fillStyle = METAL_HI;
    ctx.fillRect(x - bw / 2, bodyY, bw, bodyH * 0.12);
    var hy = bodyY + bodyH * 0.55;
    var hh = bodyH * 0.24;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - bw / 2, hy, bw, hh);
    ctx.clip();
    ctx.fillStyle = HAZARD_B;
    ctx.fillRect(x - bw / 2, hy, bw, hh);
    ctx.fillStyle = HAZARD_A;
    var sw = hh * 0.9;
    for (var sx = x - bw / 2 - hh; sx < x + bw / 2; sx += sw * 2) {
      ctx.beginPath();
      ctx.moveTo(sx, hy + hh);
      ctx.lineTo(sx + hh, hy);
      ctx.lineTo(sx + hh + sw, hy);
      ctx.lineTo(sx + sw, hy + hh);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // The bit: a gold cone, its lit half and shadow half, with grooves that
    // run down it while it turns.
    var top = tipY - bitH;
    ctx.fillStyle = GOLD_DARK;
    ctx.beginPath();
    ctx.moveTo(x - bw * 0.46, top);
    ctx.lineTo(x + bw * 0.46, top);
    ctx.lineTo(x, tipY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(x - bw * 0.46, top);
    ctx.lineTo(x + bw * 0.06, top);
    ctx.lineTo(x, tipY);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(23, 21, 18, 0.55)';
    ctx.lineWidth = Math.max(2, bw * 0.05);
    var turn = digging ? (t * 0.012) % 1 : 0;
    for (var g = 0; g < 4; g++) {
      var f = (g + turn) / 4; // 0 at the shoulder, 1 at the tip
      var half = bw * 0.46 * (1 - f);
      var gy = top + bitH * f;
      ctx.beginPath();
      ctx.moveTo(x - half, gy);
      ctx.lineTo(x + half, gy + bitH * 0.12 * (1 - f));
      ctx.stroke();
    }
  }

  function spawnSpoil(x, y, band) {
    var i = debNext * 6;
    debNext = (debNext + 1) % DEB_N;
    var side = Math.random() < 0.5 ? -1 : 1;
    deb[i] = x + side * unit * 0.3;
    deb[i + 1] = y;
    deb[i + 2] = side * (0.15 + Math.random() * 0.45) * unit * 0.06;
    deb[i + 3] = -(0.3 + Math.random() * 0.6) * unit * 0.06;
    deb[i + 4] = 1;
    deb[i + 5] = band;
  }

  function drawSpoil(dt) {
    var g = unit * 0.0006;
    var sz = unit * 0.08;
    for (var n = 0; n < DEB_N; n++) {
      var i = n * 6;
      if (deb[i + 4] <= 0) continue;
      deb[i + 2] *= 0.995;
      deb[i + 3] += g * dt;
      deb[i] += deb[i + 2] * dt * 0.06;
      deb[i + 1] += deb[i + 3] * dt * 0.06;
      deb[i + 4] -= dt / 700;
      if (deb[i + 4] <= 0) continue;
      ctx.globalAlpha = deb[i + 4];
      ctx.fillStyle = STRATA[deb[i + 5]];
      ctx.fillRect(deb[i] - sz / 2, deb[i + 1] - sz / 2, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  function drawStrike(t, x, y) {
    var f = (t - STRIKE) / 650;
    if (f < 0 || f > 1) return;
    var maxR = Math.hypot(W, H) * 0.6;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = (1 - f) * 0.9;
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 7 * (1 - f) + 1;
    ctx.beginPath();
    ctx.arc(x, y, maxR * easeInOut(f) + 4, 0, Math.PI * 2);
    ctx.stroke();
    var bl = clamp01(1 - f * 2.5);
    if (bl > 0) {
      ctx.globalAlpha = bl * 0.85;
      ctx.fillStyle = GOLD_HOT;
      ctx.beginPath();
      ctx.arc(x, y, unit * 0.6 + unit * 3 * f, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // The name, centred on (cx, cy), at font size `sz` with letter spacing
  // `sp` (a fraction of the size): white with the menu's brass glow.
  function drawWord(cx, cy, sz, sp, alpha) {
    var k = sz / 100;
    var total = wordW100 + (sp - SPACING) * 100 * (WORD.length - 1);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, cx * dpr, cy * dpr);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    // shadowBlur ignores the transform, so it is given in device pixels.
    for (var pass = 0; pass < 2; pass++) {
      ctx.shadowColor = pass === 0 ? 'rgba(255, 138, 31, 0.4)' : 'rgba(255, 194, 31, 0.6)';
      ctx.shadowBlur = (pass === 0 ? 1.1 : 0.42) * sz * dpr;
      var gx = -total / 2;
      for (var i = 0; i < WORD.length; i++) {
        ctx.fillText(WORD.charAt(i), gx, 0);
        gx += glyphW[i] + sp * 100;
      }
    }
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'rgba(0, 0, 0, 0)';
    ctx.globalAlpha = 1;
  }

  var last = 0;

  function frame(now) {
    if (done) return;
    try {
      if (!t0) { t0 = now; last = now; }
      var t = now - t0;
      var dt = Math.min(now - last, 50);
      last = now;
      var land = clamp01((t - landAt) / landMs);
      if (land >= 1) { finish(); return; }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // How far the dig has gone dark: by DARK on its own, or within the
      // first third of a skip.
      var dark = clamp01((t - LOGO_IN) / (DARK - LOGO_IN));
      if (land > 0) dark = Math.max(dark, clamp01(land * 3));

      var sh = land > 0 ? 0 : shakeAt(t);
      var ox = sh ? (Math.random() * 2 - 1) * sh : 0;
      var oy = sh ? (Math.random() * 2 - 1) * sh : 0;

      if (dark < 1) {
        var d = depthAt(t);
        var rigX = W / 2;
        // The rig drops in from above and comes to rest with its tip on the
        // surface; from then on the ground moves, not the rig.
        // On a short landscape phone the rig is tall against the screen, so
        // its body (1.75 units above the tip) is never allowed off the top.
        var restY = Math.max((SURFACE + 0.05) * H, unit * 1.9);
        var e = clamp01(t / ENTER);
        var tipY = -unit * 0.3 + (restY + unit * 0.3) * (1 - Math.pow(1 - e, 3));
        var digging = t > DIG && t < STRIKE;

        ctx.setTransform(dpr, 0, 0, dpr, ox * dpr, oy * dpr);
        drawGround(d, rigX, tipY);
        if (digging) {
          // Spoil in the colour of the band at the tip.
          var at = d + tipY / H;
          var band = 0;
          for (var b = 1; b < STRATA.length; b++) if (at >= bandTop[b]) band = b;
          spawnSpoil(rigX, tipY, band);
          spawnSpoil(rigX, tipY, band);
        }
        drawSpoil(dt);
        drawRig(rigX, tipY, t, digging);
        if (land === 0) drawStrike(t, rigX, tipY);

        // The dark rising behind the name.
        if (dark > 0) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.globalAlpha = dark;
          ctx.fillStyle = BG;
          ctx.fillRect(0, 0, W, H);
          ctx.globalAlpha = 1;
        }
      } else {
        // The curtain itself, which thins away during the hand-off and lets
        // the start screen show through.
        ctx.globalAlpha = 1 - easeInOut(land);
        ctx.fillStyle = BG;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }

      // The name: slams down from oversize with a little give, rests, then
      // flies home.
      var li = (t - LOGO_IN) / LOGO_MS;
      if (land > 0 && li < 1) li = 1; // a skip before the slam lands it whole
      if (li > 0) {
        var sz = Math.min((W * 0.84) / (wordW100 / 100), H * 0.2, 130);
        var sp = SPACING;
        var cx = W / 2 + ox;
        var cy = H / 2 + oy;
        var scale = 2.3 - 1.3 * easeOutBack(clamp01(li));
        var alpha = clamp01(li * 3);
        sz *= scale;
        if (land > 0) {
          if (target === null) target = findTarget() || false;
          var k = easeInOut(land);
          if (target) {
            cx += (target.x - cx) * k;
            cy += (target.y - cy) * k;
            sz += (target.size - sz) * k;
            sp += (target.spacing - sp) * k;
          } else {
            alpha *= 1 - k; // nothing on screen to land on: just fade
          }
        }
        drawWord(cx, cy, sz, sp, alpha);
      }
    } catch (err) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    size();
    measure();
    window.addEventListener('resize', size);
    window.addEventListener('keydown', onKey, true);
    canvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      skip();
    });
    document.body.appendChild(canvas);
    raf = requestAnimationFrame(frame);
    // Whatever happens to the frame loop, the curtain does not outstay this.
    setTimeout(finish, 6000);
  }

  // Loaded from the top of <body>, so the body exists even though the rest
  // of the page has not been parsed yet.
  try {
    start();
  } catch (e) {
    finish();
  }
})();
