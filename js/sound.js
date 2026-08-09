/* =============================================================================
 * SUPERMINE — js/sound.js                      [OWNER: Agent 3 — presentation]
 * -----------------------------------------------------------------------------
 * A small procedural WebAudio engine. No assets, no network, no libraries.
 *
 * SIGNAL PATH
 *   engineBus ─┐
 *   grindBus  ─┤
 *   rhythmBus ─┼─> master (gain, muted here) ─> limiter (compressor) ─> out
 *   sfxBus    ─┘
 *
 * WHY THE HOT EVENTS ONLY INCREMENT COUNTERS
 *   material:destroyed fires ~150x per step and resource:collected ~30x.
 *   Building a voice per event is impossible. Instead the handlers do nothing
 *   but bump integers; update() reads those counters once per step and decides
 *   what the excavation should SOUND like this instant (a light crack, a heavy
 *   collapse, a two-note arpeggio, ...). That is both cheaper and more musical.
 *
 * DEGRADATION
 *   Everything is behind `if (!actx) return;`. If AudioContext is missing,
 *   blocked, or throws at any point the whole module goes quiet and the game
 *   is unaffected.
 *
 * Public API (contract)
 *   SM.sound.init() / update(dt) / reset()
 *   SM.sound.play(name, opts?)   'break' 'hit' 'collect' 'impact' 'gate'
 *                                'upgrade' 'clank' 'sparkle' 'boom' 'riser'
 *                                'complete' 'ui' 'timeplus' 'timelow' 'tick'
 *                                'timeout'
 *   SM.sound.setMuted(b) / toggleMute() / isMuted()
 * ========================================================================== */

var SM = SM || {};

SM.sound = (function () {
  'use strict';

  /* =====================================================================
   * Agent-3 tunables
   * ================================================================== */
  var ENGINE_BASE_HZ   = 46;
  var ENGINE_GAIN      = 0.075;
  var GRIND_GAIN       = 0.13;
  var SFX_GAIN         = 0.9;
  var RHYTHM_GAIN      = 0.5;

  var VOICE_LIMIT      = 18;     // hard cap on concurrent one-shot voices
  var VOICE_LIMIT_SOFT = 12;     // above this, only "important" sounds get in

  // Collection arpeggio: a pentatonic ladder that climbs while you keep
  // collecting and resets after a short silence. This is the single most
  // satisfying sound in the game — keep it.
  var ARP_STEPS        = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
  var ARP_ROOT_HZ      = 392.0;  // G4
  var ARP_RESET_TIME   = 0.45;
  var ARP_MIN_GAP      = 0.045;  // throttle for a bare SM.sound.play('collect')
  var ARP_NOTE_GAP     = 0.055;  // spacing of the staggered ladder in update()

  var BREAK_MIN_GAP    = 0.05;
  var TICK_MIN_GAP     = 0.30;   // ui.js fires one tick per second under 10s
  var CRUNCH_MIN_GAP   = 0.16;
  var CRUNCH_THRESHOLD = 26;     // destroys per step that counts as a collapse

  var RHYTHM_BPM       = 128;
  var GRIND_ATTACK     = 6.0;
  var GRIND_RELEASE    = 2.6;

  var C = SM.config;

  /* =====================================================================
   * Graph state
   * ================================================================== */
  var actx = null;
  var master = null, limiter = null;
  var sfxBus = null, engineBus = null, grindBus = null, rhythmBus = null;
  var dead = false;              // audio permanently unavailable

  var muted = false;
  var unlocked = false;
  var voices = 0;

  var lastPlayed = Object.create(null);
  var clock = 0;

  // engine drone graph
  var engOsc = null, engOsc2 = null, engSub = null, engGain = null, engFilter = null;
  // grinding loop graph
  var grindSrc = null, grindGain = null, grindFilt = null, grindHi = null, grindHiGain = null;

  var noiseBuffer = null;        // short white noise, reused by percussion
  var loopBuffer = null;         // seamless looping noise for the grinder

  /* =====================================================================
   * Per-step activity counters (written by hot handlers, read by update)
   * ================================================================== */
  var nDestroy = 0, topDestroyValue = 0;
  var nCollect = 0, collectValue = 0, nSparkle = 0;
  var nHit = 0, hitIntensity = 0;

  var grindTarget = 0, grindLevel = 0;
  var arpIndex = 0, arpLast = -999, arpGate = 0;

  var zoneLevel = 0;             // 0..4 escalating rhythmic intensity
  var overdrive = 0, overdriveTarget = 0, overdriveLeft = 0;
  var odOsc = null, odGain = null, odFilt = null;

  var beatPos = 0;               // 16th-note counter
  var lastBeat = -1;

  var subscribed = false;

  /* =====================================================================
   * CONTEXT
   * ================================================================== */
  function ensureContext() {
    if (actx) return true;
    if (dead) return false;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { dead = true; return false; }
    try {
      actx = new AC();

      limiter = actx.createDynamicsCompressor();
      // Glue the whole mix so a torrent of debris cannot clip the output.
      limiter.threshold.value = -12;
      limiter.knee.value = 6;
      limiter.ratio.value = 8;
      limiter.attack.value = 0.004;
      limiter.release.value = 0.16;
      limiter.connect(actx.destination);

      master = actx.createGain();
      master.gain.value = muted ? 0 : C.SOUND_MASTER_GAIN;
      master.connect(limiter);

      sfxBus = actx.createGain();    sfxBus.gain.value = SFX_GAIN;    sfxBus.connect(master);
      engineBus = actx.createGain(); engineBus.gain.value = 1;        engineBus.connect(master);
      grindBus = actx.createGain();  grindBus.gain.value = 1;         grindBus.connect(master);
      rhythmBus = actx.createGain(); rhythmBus.gain.value = RHYTHM_GAIN; rhythmBus.connect(master);

      buildNoise();
      buildEngine();
      buildGrinder();
      buildOverdrive();
      unlocked = true;
      return true;
    } catch (e) {
      dead = true;
      actx = null;
      return false;
    }
  }

  function buildNoise() {
    // 2 s so even the longest burst ('complete') never runs off the end, and
    // so every burst can start at a random offset without repeating audibly.
    var n = (actx.sampleRate * 2.0) | 0;
    noiseBuffer = actx.createBuffer(1, n, actx.sampleRate);
    var d = noiseBuffer.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;

    // Two seconds of noise for the looping grinder. Cross-fade the tail into
    // the head so the loop point is inaudible.
    var m = (actx.sampleRate * 2) | 0;
    loopBuffer = actx.createBuffer(1, m, actx.sampleRate);
    var e = loopBuffer.getChannelData(0);
    for (var j = 0; j < m; j++) e[j] = Math.random() * 2 - 1;
    var fade = (actx.sampleRate * 0.05) | 0;
    for (var f = 0; f < fade; f++) {
      var t = f / fade;
      e[f] = e[f] * t + e[m - fade + f] * (1 - t);
    }
  }

  /** Low industrial drone: two detuned oscillators + a sub, through a lowpass. */
  function buildEngine() {
    engGain = actx.createGain();
    engGain.gain.value = 0;

    engFilter = actx.createBiquadFilter();
    engFilter.type = 'lowpass';
    engFilter.frequency.value = 300;
    engFilter.Q.value = 3.0;

    engOsc = actx.createOscillator();
    engOsc.type = 'sawtooth';
    engOsc.frequency.value = ENGINE_BASE_HZ;

    engOsc2 = actx.createOscillator();
    engOsc2.type = 'square';
    engOsc2.frequency.value = ENGINE_BASE_HZ * 1.505;   // beating -> "chugging"

    engSub = actx.createOscillator();
    engSub.type = 'sine';
    engSub.frequency.value = ENGINE_BASE_HZ * 0.5;
    var subG = actx.createGain();
    subG.gain.value = 0.75;

    engOsc.connect(engFilter);
    engOsc2.connect(engFilter);
    engSub.connect(subG); subG.connect(engFilter);
    engFilter.connect(engGain);
    engGain.connect(engineBus);
    try { engOsc.start(); engOsc2.start(); engSub.start(); } catch (e) { /* ignore */ }
  }

  /** Grinding loop: filtered noise band + a thin screech layer on top. */
  function buildGrinder() {
    grindGain = actx.createGain();
    grindGain.gain.value = 0;

    grindFilt = actx.createBiquadFilter();
    grindFilt.type = 'bandpass';
    grindFilt.frequency.value = 900;
    grindFilt.Q.value = 1.1;

    grindHi = actx.createBiquadFilter();
    grindHi.type = 'bandpass';
    grindHi.frequency.value = 3400;
    grindHi.Q.value = 7;
    grindHiGain = actx.createGain();
    grindHiGain.gain.value = 0.22;

    grindSrc = actx.createBufferSource();
    grindSrc.buffer = loopBuffer;
    grindSrc.loop = true;

    grindSrc.connect(grindFilt);
    grindSrc.connect(grindHi);
    grindHi.connect(grindHiGain);
    grindFilt.connect(grindGain);
    grindHiGain.connect(grindGain);
    grindGain.connect(grindBus);
    try { grindSrc.start(); } catch (e) { /* ignore */ }
  }

  /** Sustained overdrive intensity layer — a pulsing filtered saw. */
  function buildOverdrive() {
    odGain = actx.createGain();
    odGain.gain.value = 0;
    odFilt = actx.createBiquadFilter();
    odFilt.type = 'bandpass';
    odFilt.frequency.value = 500;
    odFilt.Q.value = 2.5;
    odOsc = actx.createOscillator();
    odOsc.type = 'sawtooth';
    odOsc.frequency.value = 82;
    odOsc.connect(odFilt);
    odFilt.connect(odGain);
    odGain.connect(engineBus);
    try { odOsc.start(); } catch (e) { /* ignore */ }
  }

  /* =====================================================================
   * VOICE PRIMITIVES
   * ================================================================== */
  function canVoice(important) {
    if (!actx || muted) return false;
    return voices < (important ? VOICE_LIMIT : VOICE_LIMIT_SOFT);
  }

  function countVoice(node) {
    voices++;
    node.onended = function () { if (voices > 0) voices--; };
  }

  function noiseBurst(dur, freq, q, gain, type, delay) {
    if (!actx) return;
    var src = actx.createBufferSource();
    src.buffer = noiseBuffer;
    var f = actx.createBiquadFilter();
    f.type = type || 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    var g = actx.createGain();
    var t = actx.currentTime + (delay || 0);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(sfxBus);
    // Random playback offset so repeated hits never sound identical. Clamped
    // so the burst can never run off the end of the buffer and go silent.
    var maxOff = noiseBuffer.duration - dur - 0.05;
    if (maxOff < 0) maxOff = 0;
    try { src.start(t, Math.random() * maxOff); } catch (e) { try { src.start(t); } catch (e2) { return; } }
    src.stop(t + dur + 0.02);
    countVoice(src);
  }

  function tone(freq, freq2, dur, gain, type, delay, dest) {
    if (!actx) return;
    var o = actx.createOscillator();
    o.type = type || 'triangle';
    var g = actx.createGain();
    var t = actx.currentTime + (delay || 0);
    o.frequency.setValueAtTime(freq, t);
    if (freq2 && freq2 !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(dest || sfxBus);
    o.start(t);
    o.stop(t + dur + 0.02);
    countVoice(o);
  }

  /**
   * One rung of the collection ladder. Rapid pickups climb an ascending
   * pentatonic scale and the ladder resets after a short silence — this is
   * what makes a loot torrent feel like a payout instead of a rattle.
   */
  function collectNote(delay) {
    if (!actx) return;
    if (clock - arpLast > ARP_RESET_TIME) arpIndex = 0;
    arpLast = clock;
    var st = ARP_STEPS[arpIndex % ARP_STEPS.length];
    var oct = (arpIndex / ARP_STEPS.length) | 0;
    var hz = ARP_ROOT_HZ * Math.pow(2, (st + oct * 3) / 12);
    if (hz > 3800) hz = 3800;
    arpIndex++;
    if (arpIndex > 40) arpIndex = 24;      // plateau instead of squeaking
    tone(hz, hz * 1.01, 0.09, 0.13, 'triangle', delay);
    tone(hz * 2, hz * 2, 0.05, 0.045, 'sine', delay);
  }

  /** Inharmonic partial stack — the metal in "metallic clank". */
  function clank(baseHz, dur, gain) {
    if (!actx) return;
    noiseBurst(0.03, baseHz * 3.2, 3, gain * 0.5, 'bandpass');
    tone(baseHz, baseHz * 0.96, dur, gain * 0.55, 'square');
    tone(baseHz * 2.76, baseHz * 2.7, dur * 0.7, gain * 0.30, 'sine');
    tone(baseHz * 5.41, baseHz * 5.3, dur * 0.42, gain * 0.16, 'sine');
  }

  /* =====================================================================
   * ONE-SHOTS
   * ================================================================== */
  function play(name, opts) {
    if (muted || !unlocked || !actx) return;

    // The clock outranks the excavation: a +10s or a run-over stinger must
    // never be swallowed by a torrent of debris voices.
    var important = (name === 'upgrade' || name === 'boom' || name === 'riser' ||
                     name === 'complete' || name === 'gate' || name === 'ui' ||
                     name === 'timeplus' || name === 'timeout' || name === 'timelow');
    if (!canVoice(important)) return;

    var minGap = C.SOUND_MIN_INTERVAL;
    if (name === 'tick') minGap = TICK_MIN_GAP;
    else if (name === 'break') minGap = BREAK_MIN_GAP;
    else if (name === 'collect') minGap = ARP_MIN_GAP;
    else if (name === 'hit') minGap = 0.09;
    else if (name === 'crunch') minGap = CRUNCH_MIN_GAP;
    else if (name === 'sparkle') minGap = 0.10;
    else if (name === 'clank') minGap = 0.11;
    else if (important) minGap = 0;

    var last = lastPlayed[name];
    if (last !== undefined && clock - last < minGap) return;
    lastPlayed[name] = clock;

    var v = (opts && opts.variation !== undefined) ? opts.variation : Math.random();

    switch (name) {

      /* --- destruction --------------------------------------------- */
      case 'break':                    // light crack of a single deposit
        noiseBurst(0.075 + v * 0.05, 420 + v * 780, 1.5, 0.42);
        break;

      case 'crunch':                   // many deposits collapsing at once
        noiseBurst(0.22 + v * 0.10, 200 + v * 180, 0.8, 0.62, 'lowpass');
        noiseBurst(0.11, 1400 + v * 900, 1.2, 0.26);
        tone(120 - v * 25, 58, 0.20, 0.24, 'sine');
        break;

      case 'hit':                      // cutter skittering across hard rock
        noiseBurst(0.045, 2300 + v * 2700, 6, 0.20, 'bandpass');
        break;

      case 'impact':                   // stone thud
        noiseBurst(0.28, 105 + v * 95, 0.9, 0.70, 'lowpass');
        tone(92, 42, 0.26, 0.28, 'sine');
        break;

      case 'clank':                    // metal on metal
        clank(260 + v * 220, 0.24, 0.30);
        break;

      /* --- loot ------------------------------------------------------ */
      case 'collect':
        collectNote(0);
        break;

      case 'sparkle': {                // gem / crystal tinkle
        var base = 1500 + v * 900;
        tone(base, base * 1.02, 0.10, 0.10, 'sine');
        tone(base * 1.5, base * 1.52, 0.08, 0.07, 'sine', 0.035);
        tone(base * 2.02, base * 2.0, 0.07, 0.05, 'sine', 0.075);
        noiseBurst(0.05, 6200, 9, 0.07);
        break;
      }

      /* --- events ---------------------------------------------------- */
      case 'gate':
        tone(392, 784, 0.16, 0.16, 'square');
        tone(587, 1175, 0.14, 0.10, 'triangle', 0.05);
        noiseBurst(0.18, 1800, 1.0, 0.18);
        break;

      case 'upgrade': {
        // Rising arpeggio + chord stack + whoosh + a low boom underneath.
        var root = 220;
        var seq = [0, 4, 7, 12, 16, 19, 24];
        for (var i = 0; i < seq.length; i++) {
          var f = root * Math.pow(2, seq[i] / 12);
          tone(f, f * 1.005, 0.30, 0.10, i > 3 ? 'triangle' : 'sawtooth', i * 0.055);
        }
        tone(root * 0.5, root * 0.5, 0.9, 0.16, 'sawtooth', 0.05);
        tone(root * 2, root * 3, 0.55, 0.09, 'triangle', 0.30);
        noiseBurst(0.55, 1100, 0.6, 0.32, 'lowpass');
        noiseBurst(0.9, 320, 0.5, 0.30, 'lowpass', 0.04);
        tone(120, 48, 0.5, 0.26, 'sine');
        break;
      }

      case 'boom':                     // explosive mining pulse
        noiseBurst(0.55, 160, 0.5, 0.85, 'lowpass');
        noiseBurst(0.28, 900, 0.8, 0.34);
        tone(150, 32, 0.55, 0.42, 'sine');
        tone(78, 28, 0.75, 0.30, 'triangle', 0.02);
        break;

      case 'riser': {                  // overdrive spin-up
        if (!actx) break;
        var o = actx.createOscillator();
        var f2 = actx.createBiquadFilter();
        var g2 = actx.createGain();
        var t2 = actx.currentTime;
        var dur = (opts && opts.duration) || 1.1;
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(70, t2);
        o.frequency.exponentialRampToValueAtTime(620, t2 + dur);
        f2.type = 'bandpass'; f2.Q.value = 4;
        f2.frequency.setValueAtTime(300, t2);
        f2.frequency.exponentialRampToValueAtTime(4200, t2 + dur);
        g2.gain.setValueAtTime(0.0001, t2);
        g2.gain.exponentialRampToValueAtTime(0.26, t2 + dur * 0.85);
        g2.gain.exponentialRampToValueAtTime(0.0008, t2 + dur + 0.18);
        o.connect(f2); f2.connect(g2); g2.connect(sfxBus);
        o.start(t2); o.stop(t2 + dur + 0.22);
        countVoice(o);
        noiseBurst(dur, 2600, 1.0, 0.14, 'highpass');
        break;
      }

      case 'complete': {
        var rt = 261.63;
        var chord = [0, 4, 7, 12, 16, 19, 24, 28];
        for (var j = 0; j < chord.length; j++) {
          var ff = rt * Math.pow(2, chord[j] / 12);
          tone(ff, ff, 1.5 - j * 0.08, 0.085, j > 4 ? 'sine' : 'triangle', j * 0.07);
        }
        tone(rt * 0.5, rt * 0.5, 1.9, 0.16, 'sawtooth');
        noiseBurst(1.4, 500, 0.5, 0.28, 'lowpass');
        break;
      }

      /* --- the clock ------------------------------------------------- */
      case 'timeplus': {
        // Bright rising fifth + octave shimmer: unmistakably a REWARD, and
        // pitched well above the engine drone so it cuts through the grind.
        var tb = 523.25;                       // C5
        tone(tb, tb, 0.14, 0.17, 'triangle');
        tone(tb * 1.5, tb * 1.5, 0.16, 0.13, 'triangle', 0.07);
        tone(tb * 2, tb * 2.01, 0.34, 0.10, 'sine', 0.15);
        tone(tb * 0.5, tb * 0.75, 0.38, 0.11, 'sawtooth', 0.02);
        noiseBurst(0.12, 5400, 8, 0.09, 'bandpass', 0.14);
        break;
      }

      case 'timelow':                  // one-shot alarm as the wire is crossed
        tone(880, 880, 0.11, 0.17, 'square');
        tone(880, 660, 0.15, 0.15, 'square', 0.16);
        noiseBurst(0.08, 2600, 4, 0.10, 'bandpass');
        break;

      case 'tick':                     // per-second pip inside the last 10s
        tone(1500, 1400, 0.028, 0.075, 'square');
        noiseBurst(0.026, 2400, 7, 0.10);
        break;

      case 'timeout':                  // the machine stops
        tone(392, 62, 1.15, 0.26, 'sawtooth');
        tone(196, 40, 1.35, 0.20, 'square', 0.05);
        tone(110, 33, 0.95, 0.28, 'sine', 0.10);
        noiseBurst(0.95, 250, 0.6, 0.44, 'lowpass');
        break;

      case 'ui':
        tone(660, 880, 0.06, 0.10, 'square');
        break;

      default:
        break;
    }
  }

  /* =====================================================================
   * RHYTHMIC INTENSITY LAYER
   * A 16th-note grid. Which voices fire depends on the zone level, so the
   * soundtrack thickens as the run escalates and goes big in the final zone.
   * ================================================================== */
  function rhythmStep(stepIdx) {
    if (!actx || muted || zoneLevel <= 0) return;
    var s = stepIdx & 15;
    var lvl = zoneLevel;

    // Kick on the downbeats from level 2.
    if (lvl >= 2 && (s === 0 || s === 8 || (lvl >= 4 && s === 6))) {
      tone(105, 40, 0.20, 0.42, 'sine', 0, rhythmBus);
      noiseBurst(0.05, 140, 0.7, 0.18, 'lowpass');
    }
    // Industrial hat / shaker from level 3.
    if (lvl >= 3 && (s & 1) === 0) {
      var src = actx.createBufferSource();
      src.buffer = noiseBuffer;
      var f = actx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 7000;
      var g = actx.createGain();
      var t = actx.currentTime;
      var amp = (s % 4 === 0) ? 0.10 : 0.045;
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.0006, t + 0.045);
      src.connect(f); f.connect(g); g.connect(rhythmBus);
      try { src.start(t, Math.random() * 0.3); } catch (e) { return; }
      src.stop(t + 0.07);
      countVoice(src);
    }
    // Low pulse from level 1 (barely there — just a heartbeat).
    if (lvl === 1 && s === 0) {
      tone(70, 55, 0.32, 0.20, 'sine', 0, rhythmBus);
    }
    // Final zone: driving bass stab + an offbeat metal hit.
    if (lvl >= 4) {
      if (s === 4 || s === 12) {
        tone(147, 147, 0.16, 0.24, 'sawtooth', 0, rhythmBus);
        tone(73.5, 73.5, 0.20, 0.20, 'square', 0, rhythmBus);
      }
      if (s === 14) clank(320, 0.16, 0.14);
    }
  }

  /* =====================================================================
   * HOT EVENT HANDLERS — integer bumps only, nothing else
   * ================================================================== */
  function onDestroyed(p) {
    nDestroy++;
    var m = SM.materials.get(p.matIndex);
    var v = m ? m.value : 0;
    if (v > topDestroyValue) topDestroyValue = v;
  }
  function onCollected(p) {
    nCollect++;
    collectValue += p.value;
    var m = SM.materials.get(p.matIndex);
    if (m && m.sparkle >= 0.7) nSparkle++;
  }
  function onHit(p) {
    nHit++;
    if (p.intensity > hitIntensity) hitIntensity = p.intensity;
  }

  /* =====================================================================
   * UPDATE — turns the counters into sound, drives the loops
   * ================================================================== */
  function update(dt) {
    clock += dt;

    if (overdriveLeft > 0) {
      overdriveLeft -= dt;
      if (overdriveLeft <= 0) overdriveTarget = 0;
    }
    overdrive += (overdriveTarget - overdrive) * Math.min(1, dt * 3.5);

    if (!unlocked || !actx) {
      nDestroy = nCollect = nHit = 0;
      topDestroyValue = collectValue = hitIntensity = 0;
      return;
    }

    /* --- destruction --------------------------------------------------- */
    if (nDestroy > 0) {
      if (nDestroy >= CRUNCH_THRESHOLD) {
        play('crunch');
        if (nDestroy >= CRUNCH_THRESHOLD * 2.5) play('impact');
      } else {
        play('break');
      }
      if (topDestroyValue >= 80) play('sparkle');
      else if (topDestroyValue >= 25 && Math.random() < 0.5) play('clank');
    }

    /* --- collection ---------------------------------------------------- */
    if (nCollect > 0 && !muted && clock >= arpGate) {
      // Fire up to 3 rungs per step, STAGGERED in real time, so a torrent runs
      // UP the scale instead of retriggering one note on top of itself. The
      // gate advances by exactly the length of the burst, capping the ladder
      // at ~18 notes/sec however hard the loot is pouring in.
      var notes = nCollect > 6 ? 3 : nCollect > 2 ? 2 : 1;
      if (canVoice(false)) {
        for (var i = 0; i < notes; i++) collectNote(i * ARP_NOTE_GAP);
      }
      arpGate = clock + notes * ARP_NOTE_GAP;
      if (nSparkle > 0 && Math.random() < 0.5) play('sparkle');
    }

    /* --- grinding loop -------------------------------------------------- */
    var load = 0;
    if (SM.vehicle && SM.vehicle.getResistance) {
      load = Math.min(1, SM.vehicle.getResistance() * 0.0050);
    }
    // material:hit activity feeds the grinder even when resistance is low
    // (fast cutting through soft ground still rasps).
    var hitAct = Math.min(1, nHit * 0.34 + hitIntensity * 0.4);
    grindTarget = Math.max(load, hitAct * 0.8);
    var gk = grindTarget > grindLevel ? GRIND_ATTACK : GRIND_RELEASE;
    grindLevel += (grindTarget - grindLevel) * Math.min(1, gk * dt);
    if (grindLevel < 0.0015) grindLevel = 0;

    if (grindGain) {
      grindGain.gain.value = muted ? 0 : GRIND_GAIN * grindLevel * (1 + overdrive * 0.5);
      // Wobble the band so it sounds like a rotating cutter, not a noise gate.
      grindFilt.frequency.value = 620 + grindLevel * 900 + Math.sin(clock * 7.3) * 140;
      grindHi.frequency.value = 3000 + Math.sin(clock * 11.7) * 900 + grindLevel * 1400;
      grindHiGain.gain.value = 0.10 + grindLevel * 0.34;
    }

    /* --- engine drone --------------------------------------------------- */
    var speed = 0;
    if (SM.vehicle && SM.vehicle.getSpeed) {
      speed = SM.vehicle.getSpeed() / Math.max(1, C.VEHICLE_SPEED);
    }
    if (engGain) {
      var target = muted ? 0
        : ENGINE_GAIN * (0.5 + speed * 0.4 + load * 0.8 + overdrive * 0.5);
      engGain.gain.value += (target - engGain.gain.value) * Math.min(1, dt * 4);
      var hz = ENGINE_BASE_HZ * (0.84 + speed * 0.34 + load * 0.22 + overdrive * 0.26);
      engOsc.frequency.value = hz;
      engOsc2.frequency.value = hz * 1.505;
      engSub.frequency.value = hz * 0.5;
      engFilter.frequency.value = 210 + load * 900 + speed * 240 + overdrive * 500;
    }

    /* --- overdrive intensity layer -------------------------------------- */
    if (odGain) {
      odGain.gain.value = muted ? 0 : 0.055 * overdrive * (0.7 + 0.3 * Math.sin(clock * 12));
      odFilt.frequency.value = 380 + 420 * (0.5 + 0.5 * Math.sin(clock * 5.1)) + overdrive * 500;
      odOsc.frequency.value = 82 * (1 + overdrive * 0.12);
    }

    /* --- rhythm grid ----------------------------------------------------- */
    if (zoneLevel > 0) {
      var bpm = RHYTHM_BPM * (1 + (zoneLevel >= 4 ? 0.14 : 0) + overdrive * 0.06);
      beatPos += dt * (bpm / 60) * 4;          // 16th notes
      var b = beatPos | 0;
      if (b !== lastBeat) {
        lastBeat = b;
        rhythmStep(b);
      }
    }

    /* --- clear per-step counters ------------------------------------------ */
    nDestroy = 0; topDestroyValue = 0;
    nCollect = 0; collectValue = 0; nSparkle = 0;
    nHit = 0; hitIntensity = 0;
  }

  /* =====================================================================
   * MUTE / LIFECYCLE
   * ================================================================== */
  function setMuted(b) {
    muted = !!b;
    if (master && actx) {
      // Ramp instead of a jump: a hard gain change on a running graph clicks.
      try {
        master.gain.setTargetAtTime(muted ? 0 : C.SOUND_MASTER_GAIN, actx.currentTime, 0.02);
      } catch (e) {
        master.gain.value = muted ? 0 : C.SOUND_MASTER_GAIN;
      }
    }
    SM.events.emit('sound:muted', muted);
  }
  function toggleMute() { setMuted(!muted); }
  function isMuted() { return muted; }

  function reset() {
    clock = 0;
    for (var k in lastPlayed) delete lastPlayed[k];
    nDestroy = nCollect = nHit = 0;
    topDestroyValue = collectValue = hitIntensity = nSparkle = 0;
    grindTarget = grindLevel = 0;
    arpIndex = 0; arpLast = -999; arpGate = 0;
    zoneLevel = 0;
    overdrive = overdriveTarget = overdriveLeft = 0;
    beatPos = 0; lastBeat = -1;
    if (grindGain) grindGain.gain.value = 0;
    if (odGain) odGain.gain.value = 0;
  }

  function unlock() {
    if (!ensureContext()) return;
    if (actx.state === 'suspended') {
      try { actx.resume(); } catch (e) { /* ignore */ }
    }
  }

  function init() {
    if (subscribed) return;
    subscribed = true;

    // Browsers block audio until a user gesture.
    SM.events.on('input:firstgesture', unlock);
    var kick = function () {
      unlock();
      window.removeEventListener('pointerdown', kick, true);
      window.removeEventListener('keydown', kick, true);
      window.removeEventListener('touchstart', kick, true);
    };
    window.addEventListener('pointerdown', kick, true);
    window.addEventListener('keydown', kick, true);
    window.addEventListener('touchstart', kick, true);

    // Hot events: counters only.
    SM.events.on('material:destroyed', onDestroyed);
    SM.events.on('material:hit', onHit);
    SM.events.on('resource:collected', onCollected);

    // Rare events: play directly.
    SM.events.on('impact:heavy', function (p) {
      if (p && p.strength > 0.55) play('impact');
      else play('clank');
    });
    SM.events.on('gate:passed', function () { play('gate'); });
    SM.events.on('gate:missed', function () { tone(300, 150, 0.22, 0.14, 'square'); });
    SM.events.on('upgrade:applied', function () { play('upgrade'); });
    SM.events.on('vehicle:transform', function () { play('clank'); });
    SM.events.on('pulse:fired', function () { play('boom'); });
    SM.events.on('overdrive:start', function (p) {
      overdriveTarget = 1;
      overdriveLeft = (p && p.duration) || 6;
      play('riser', { duration: 1.0 });
    });
    SM.events.on('overdrive:end', function () { overdriveTarget = 0; overdriveLeft = 0; });
    SM.events.on('zone:entered', function (p) {
      var kind = p && p.kind;
      zoneLevel = kind === 'final' ? 4 : kind === 'narrow' ? 3
                : kind === 'barrier' ? 2 : kind === 'rich' ? 1 : 0;
      if (zoneLevel >= 2) play('gate');
      if (zoneLevel >= 4) play('riser', { duration: 1.6 });
    });
    SM.events.on('level:complete', function () { zoneLevel = 0; play('complete'); });

    // The countdown. ui.js owns the per-second 'tick' because it is the module
    // that already derives the danger window from the value.
    SM.events.on('time:granted', function () { play('timeplus'); });
    SM.events.on('time:low', function () { play('timelow'); });
    SM.events.on('run:over', function (p) {
      // Everything stops: kill the rhythm bed, then the stinger. A 'depth'
      // ending already got the 'complete' fanfare from level:complete, so it
      // does not also get the failure sting.
      zoneLevel = 0;
      overdriveTarget = 0; overdriveLeft = 0;
      grindTarget = 0;
      if (!p || p.reason !== 'depth') play('timeout');
    });

    SM.events.on('input:mutetoggle', function () { toggleMute(); });
  }

  return {
    init: init,
    update: update,
    play: play,
    setMuted: setMuted,
    toggleMute: toggleMute,
    isMuted: isMuted,
    reset: reset,
    isReady: function () { return unlocked && !!actx; }
  };
})();
