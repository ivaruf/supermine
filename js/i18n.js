/* =============================================================================
 * SUPERMINE — js/i18n.js                       [every word the mine says]
 * -----------------------------------------------------------------------------
 * Two languages, Norwegian first (hub CLAUDE.md §2, "Two languages"): bokmål
 * and English, switchable live from the pause menu or the sound panel.
 *
 * A CLASSIC SCRIPT, loaded from <head> before the SM scripts and before the
 * body paints, because this game is classic scripts on one global and must
 * stay that way. It hangs the hub's four names on window.I18N:
 *
 *   I18N.t(key, ...args)   the current language, else English, else the key
 *                          itself — and one console warning per missing key
 *   I18N.getLang()         'nb' | 'en'
 *   I18N.setLang(lang)     validates, stores, sets <html lang>, repaints every
 *                          [data-i18n] node, then dispatches `arcade:lang` on
 *                          document with the language as detail. ui.js listens
 *                          for that and repaints everything it built with
 *                          arguments in it (scores, verdicts, the open toast).
 *   I18N.paintStatic(root) [data-i18n] -> textContent,
 *                          [data-i18n-label] -> aria-label and title,
 *                          [data-i18n-placeholder] -> placeholder
 *
 * THE CHOICE IS THE PLAYER'S, NOT THE CABINET'S. It is stored under the one
 * key every game in the hub shares, `arcade.lang.v1`, holding "nb" or "en"
 * and nothing else. With nothing valid stored the mine speaks Norwegian,
 * whatever the browser prefers — the owner's call, not a sniffing bug.
 *
 * CANVAS TEXT is looked up by key at draw time (the gate arches in
 * upgrades.js, the zone names painted on the rock in terrain.js). A lookup
 * without arguments returns a string already sitting in the table, so the
 * draw loop allocates nothing; the keys themselves are built once, when the
 * gate or the zone is created, never per frame.
 *
 * The case is the game's: this mine shouts in ALL-CAPS brass, and so does its
 * Norwegian. Prose that is written in sentence case in English (the mode
 * blurbs, the upgrade descriptions) is in sentence case here too.
 *
 * Not translated: the SUPERMINE wordmark, names players type, the manifest,
 * console output, storage keys.
 * ========================================================================== */

(function () {
  'use strict';

  var KEY = 'arcade.lang.v1';
  var LANGS = { nb: true, en: true };

  var STRINGS = {
    nb: {
      /* --- the language row itself ------------------------------------- */
      'lang.caption': 'SPRÅK',

      /* --- the corner and the HUD plates (aria-label + title) ---------- */
      'aria.mute': 'Lyd på / av',
      'aria.pause': 'Pause',
      'aria.sound': 'Lyd',
      'aria.fullscreen': 'Fullskjerm',
      'aria.exitFullscreen': 'Avslutt fullskjerm',
      'aria.steerLeft': 'Styr til venstre',
      'aria.steerRight': 'Styr til høyre',

      /* --- HUD ----------------------------------------------------------- */
      'hud.pwr': function (n) { return 'KRAFT ' + n; },
      'hud.cut': function (n) { return 'KUTT ' + n; },
      'hud.mag': function (n) { return 'MAG ' + n; },
      'hud.time': 'TID',
      'hud.overdrive': 'SUPERMODUS',
      'hud.boost': 'TURBO',
      'hud.upgradeKicker': 'NY OPPGRADERING',
      'hud.haul': 'FANGST',
      'hud.core': function (m) { return 'KJERNEN +' + m + ' m'; },
      'hud.hint': 'A / D  •  PILTASTER  •  DRA   —   ESC pause, M lyd av',

      /* --- pause menu ---------------------------------------------------- */
      'pause.kicker': 'MOTOREN GÅR PÅ TOMGANG',
      'pause.title': 'PAUSE',
      'pause.resume': 'FORTSETT',
      'pause.restart': 'START PÅ NYTT',
      'pause.menu': 'HOVEDMENY',
      'exit.arcade': 'TILBAKE TIL ARKADEN',
      'exit.close': 'LUKK',
      'exit.refused': 'LUKK FANEN SELV',

      /* --- power-up splash, toasts -------------------------------------- */
      'splash.boost': 'TURBO!',
      'splash.boostSub': function (s) { return '+' + s + ' SEK  ·  FULL FART'; },
      'splash.secs': function (s) { return '+' + s + ' SEK'; },
      'splash.cell': 'TIDSCELLE',
      'splash.core': 'KJERNEN',
      'splash.coreSub': 'HELE KARTET ER BAK DEG  ·  GRAV VIDERE',
      'toast.missed': 'BOMMET PÅ PORTEN',
      'toast.missedSub': 'Styr inn under buen neste gang',
      'toast.upgrade': 'OPPGRADERING',

      /* --- end of run ---------------------------------------------------- */
      'sum.kicker': 'GRAVINGEN ER FERDIG',
      'sum.title': 'FERDIG',
      'sum.kickCore': function (m) { return 'HELE KARTET ER BAK DEG  ·  ' + m + ' m INN I KJERNEN'; },
      'sum.kickClock': 'KLOKKA VANT',
      'sum.kickEnded': 'GRAVINGEN ER OVER',
      'sum.titleCore': 'DU NÅDDE KJERNEN',
      'sum.titleTime': 'TIDEN ER UTE',
      'sum.score': 'POENG',
      'sum.timeLeft': 'TID IGJEN',
      'sum.depth': 'DYBDE',
      'sum.upgrades': 'OPPGRADERINGER',
      'sum.resources': 'SAMLET',
      'sum.power': 'GRAVEKRAFT',
      'sum.burst': 'STØRSTE KUPP',
      'sum.again': 'SPILL IGJEN',
      'haul.nothing': 'INGENTING SAMLET',
      'haul.noOre': 'INGEN MALM SAMLET',
      'haul.head': 'HVOR POENGENE KOM FRA',
      'hs.head': 'REKORDER',
      'hs.cta': 'NY TOPP 10 — SKRIV NAVNET DITT',
      'hs.placeholder': 'NAVNET DITT',
      'hs.save': 'LAGRE',
      'hs.blocked': 'REKORDENE ER IKKE TILGJENGELIGE — LAGRING ER BLOKKERT',
      'hs.none': 'INGEN REKORDER ENNÅ',
      'hs.failed': 'KUNNE IKKE LAGRE — DENNE TUREN BLIR IKKE HUSKET',
      // Written into the score table when the field is left empty, so it is
      // kept to the table's 12 characters.
      'hs.defaultName': 'GRAVER',

      /* --- start screen -------------------------------------------------- */
      'start.sub': 'KJØR. KNUS. GRAV DYPERE.',
      'start.pick': 'VELG HVORDAN DU VIL SPILLE',
      'mode.time': 'MOT KLOKKA',
      'mode.timeTag': function (s) {
        return s > 0 ? s + ' SEKUNDER PÅ KLOKKA' : 'SLÅ KLOKKA';
      },
      'mode.timeBlurb': 'Det du har samlet når klokka står på null, er poengene dine. ' +
        'Noen porter gir +10 SEKUNDER i stedet for en oppgradering — bytt kraft mot tid.',
      'mode.timeBadge': 'REKORDLISTE',
      'mode.free': 'FRITT SPILL',
      'mode.freeTag': 'INGEN KLOKKE · INGEN GRENSE',
      'mode.freeBlurb': 'Grav så langt du vil. Ingenting går på tid, og ingenting ' +
        'stopper turen — hver port gir en oppgradering i stedet for sekunder.',
      'mode.freeBadge': 'BARE FOR GØY',
      'mode.go': 'SPILL ▸',
      'keys.desk': 'A / D  ·  PILTASTER  ·  DRA  for å styre      ESC  pause      M  lyd av',
      'keys.touch': 'HOLD ELLER TRYKK PÅ EN AV SIDENE FOR Å STYRE',
      'update.ready': 'NY VERSJON KLAR — TRYKK FOR Å INSTALLERE',
      'update.readyV': function (v) { return v + ' KLAR — TRYKK FOR Å INSTALLERE'; },
      'update.installing': 'INSTALLERER …',

      /* --- sound panel --------------------------------------------------- */
      'sound.kicker': 'HØYTTALERNE I FØRERHUSET',
      'sound.title': 'LYD',
      'sound.music': 'MUSIKK',
      'sound.effects': 'EFFEKTER',
      'sound.hint': 'MUSIKKEN ER TAKTEN, OG DEN BLIR TYKKERE JO RIKERE ÅRENE BLIR. ' +
        'EFFEKTER ER MOTOREN, KVERNA OG ALT DU KNUSER. ' +
        'DRA I EN AV DEM, SÅ HØRER DU DEN.',
      'sound.back': 'TILBAKE',

      /* --- gates, drawn on the canvas ------------------------------------ */
      'gate.installed': 'MONTERT',
      'gate.closed': 'STENGT',
      'gate.missed': 'BOMMET',
      'gate.time': 'TID',
      'gate.hard': 'VANSKELIG VEI',
      'gate.safe': 'TRYGG VEI',
      'gate.timeDone': '+10 SEK',
      'gate.upgrade': 'OPPGRADERING',

      /* --- upgrades: arch label / toast title, and the toast line --------- */
      'up.time_10': '+10 SEKUNDER',
      'up.time_10.label': '+10 SEK',
      'up.time_10.desc': 'Ti sekunder til i gruva.',
      'up.wider_blade': 'BREDERE SKJÆREBLAD',
      'up.wider_blade.desc': 'Bladet blir 90 % bredere. Gravekraft +28 %.',
      'up.drill_heads': 'ROTERENDE BORHODER',
      'up.drill_heads.desc': 'To borhoder til. Gravekraft +45 %.',
      'up.side_grinders': 'SIDEKVERNER',
      'up.side_grinders.desc': 'Kverneskiver på sidene. Bredere skrog, +14 % kraft.',
      'up.mining_power': 'FORSTERKEDE KUTTERE',
      'up.mining_power.desc': 'Gravekraft +55 %.',
      'up.speed_up': 'TURBOMOTOR',
      'up.speed_up.desc': 'Fart framover +16 %. Et ekstra eksosrør.',
      'up.magnet': 'MAGNETSAMLERE',
      'up.magnet.desc': 'Samlearmene folder seg ut. Magneten når 65 % lenger.',
      'up.multiplier': 'MALMRAFFINERI',
      'up.multiplier.desc': 'Alt du samler er verdt 1,7 ganger mer.',
      'up.rear_conveyor': 'SAMLEBÅND BAK',
      'up.rear_conveyor.desc': 'Et samlebånd plukker opp alt bak deg.',
      'up.explosive_pulse': 'SPRENGPULS',
      'up.explosive_pulse.desc': 'Trykkbølger knuser steinen rundt riggen, igjen og igjen.',
      'up.overdrive': 'SUPERMODUS-KJERNE',
      'up.overdrive.desc': 'Av og til går alt amok: fart, kraft og magnet skyter i været.',
      'up.auto_hopper': 'STØRRE LASTEROM',
      'up.auto_hopper.desc': 'Dobbelt så mye plass. Magneten når 22 % lenger.',
      'up.mega_treads': 'TUNGE BELTER',
      'up.mega_treads.desc': 'Bredere belter. +12 % kraft, +10 % fart.',
      'up.final_overhaul': 'KJERNEKNUSEREN',
      'up.final_overhaul.desc': 'Alt, overalt, på en gang.',

      /* --- zones: the banner, the HUD line and the name on the rock ------ */
      'zone.surface': 'DAGBRUDDET',
      'zone.iron': 'JERNÅRENE',
      'zone.granite': 'GRANITTVEGGEN',
      'zone.gold': 'GULLFELTENE',
      'zone.throat': 'STRUPEN',
      'zone.gems': 'SMARAGDHULENE',
      'zone.deep': 'DYPSPERRA',
      'zone.crystal': 'KRYSTALLGROTTENE',
      'zone.pressure': 'TRYKKSLUSA',
      'zone.motherlode': 'HOVEDÅREN',
      'zone.core': 'KJERNEN',
      'zonekind.opening': 'OVERFLATEN',
      'zonekind.rich': 'RIK ÅRE',
      'zonekind.barrier': 'HARD SPERRE',
      'zonekind.narrow': 'TRANGT PASS',
      'zonekind.final': 'HOVEDÅREN',

      /* --- materials: the haul tally and the end-of-run breakdown -------- */
      'mat.dirt': 'Jord',
      'mat.stone': 'Stein',
      'mat.iron': 'Jernmalm',
      'mat.gold': 'Gull',
      'mat.gem': 'Smaragd',
      'mat.crystal': 'Krystall',
      'mat.rare': 'Mørkestein',
      'mat.rubble': 'Grus',
      'mat.granite': 'Granitt',
      'mat.starcore': 'Stjernekjerne',
      'mat.obsidian': 'Obsidian',
      'mat.timecell': 'Tidscelle',
      'mat.boostcell': 'Turbo',
      'mat.spoil': 'Gråberg'
    },

    en: {
      'lang.caption': 'LANGUAGE',

      'aria.mute': 'Sound on / off',
      'aria.pause': 'Pause',
      'aria.sound': 'Sound',
      'aria.fullscreen': 'Fullscreen',
      'aria.exitFullscreen': 'Exit fullscreen',
      'aria.steerLeft': 'Steer left',
      'aria.steerRight': 'Steer right',

      'hud.pwr': function (n) { return 'PWR ' + n; },
      'hud.cut': function (n) { return 'CUT ' + n; },
      'hud.mag': function (n) { return 'MAG ' + n; },
      'hud.time': 'TIME',
      'hud.overdrive': 'OVERDRIVE',
      'hud.boost': 'SPEED BOOST',
      'hud.upgradeKicker': 'UPGRADE ACQUIRED',
      'hud.haul': 'HAUL',
      'hud.core': function (m) { return 'CORE +' + m + ' m'; },
      'hud.hint': 'A / D  •  ARROWS  •  DRAG   —   ESC pause, M mute',

      'pause.kicker': 'ENGINE IDLING',
      'pause.title': 'PAUSED',
      'pause.resume': 'RESUME',
      'pause.restart': 'RESTART',
      'pause.menu': 'MAIN MENU',
      'exit.arcade': 'BACK TO ARCADE',
      'exit.close': 'CLOSE',
      'exit.refused': 'CLOSE THIS TAB YOURSELF',

      'splash.boost': 'BOOST MODE',
      'splash.boostSub': function (s) { return '+' + s + ' SEC  ·  SPEED SURGE'; },
      'splash.secs': function (s) { return '+' + s + ' SEC'; },
      'splash.cell': 'TIME CELL',
      'splash.core': 'THE CORE',
      'splash.coreSub': 'MAP CLEARED  ·  KEEP DIGGING',
      'toast.missed': 'GATE MISSED',
      'toast.missedSub': 'Steer into the arch next time',
      'toast.upgrade': 'UPGRADE',

      'sum.kicker': 'EXCAVATION COMPLETE',
      'sum.title': 'RUN COMPLETE',
      'sum.kickCore': function (m) { return 'THE WHOLE MAP IS BEHIND YOU  ·  ' + m + ' m INTO THE CORE'; },
      'sum.kickClock': 'THE CLOCK BEAT YOU',
      'sum.kickEnded': 'EXCAVATION ENDED',
      'sum.titleCore': 'YOU REACHED THE CORE',
      'sum.titleTime': "TIME'S UP",
      'sum.score': 'SCORE',
      'sum.timeLeft': 'TIME LEFT',
      'sum.depth': 'DEPTH',
      'sum.upgrades': 'UPGRADES',
      'sum.resources': 'RESOURCES',
      'sum.power': 'MINING POWER',
      'sum.burst': 'BEST BURST',
      'sum.again': 'PLAY AGAIN',
      'haul.nothing': 'NOTHING BANKED',
      'haul.noOre': 'NO ORE BANKED',
      'haul.head': 'WHERE IT CAME FROM',
      'hs.head': 'BEST RUNS',
      'hs.cta': 'NEW TOP 10 — ENTER YOUR NAME',
      'hs.placeholder': 'YOUR NAME',
      'hs.save': 'SAVE',
      'hs.blocked': 'HIGH SCORES UNAVAILABLE — STORAGE IS BLOCKED',
      'hs.none': 'NO RUNS RECORDED YET',
      'hs.failed': 'COULD NOT WRITE TO STORAGE — THIS RUN WILL NOT BE KEPT',
      'hs.defaultName': 'MINER',

      'start.sub': 'DRIVE. DESTROY. DIG DEEPER.',
      'start.pick': 'CHOOSE HOW TO PLAY',
      'mode.time': 'AGAINST THE CLOCK',
      'mode.timeTag': function (s) {
        return s > 0 ? s + ' SECONDS ON THE CLOCK' : 'BEAT THE CLOCK';
      },
      'mode.timeBlurb': 'Your haul when the clock hits zero is your score. Some gates pay ' +
        '+10 SECONDS instead of an upgrade — trade power for time.',
      'mode.timeBadge': 'HIGH SCORES',
      'mode.free': 'FREE PLAY',
      'mode.freeTag': 'NO CLOCK · NO LIMIT',
      'mode.freeBlurb': 'Dig as far as you like. Nothing is timed and nothing ends the run — ' +
        'every gate pays an upgrade instead of seconds.',
      'mode.freeBadge': 'JUST FOR FUN',
      'mode.go': 'PLAY ▸',
      'keys.desk': 'A / D  ·  ARROWS  ·  DRAG  to steer      ESC  pause      M  mute',
      'keys.touch': 'HOLD OR TAP EITHER SIDE TO STEER',
      'update.ready': 'UPDATE READY — TAP TO INSTALL',
      'update.readyV': function (v) { return v + ' READY — TAP TO INSTALL'; },
      'update.installing': 'INSTALLING…',

      'sound.kicker': 'CAB SPEAKERS',
      'sound.title': 'SOUND',
      'sound.music': 'MUSIC',
      'sound.effects': 'EFFECTS',
      'sound.hint': 'MUSIC IS THE BEAT THAT THICKENS AS THE SEAMS GET RICHER. ' +
        'EFFECTS IS THE ENGINE, THE GRINDER AND EVERY DEPOSIT YOU CRACK. ' +
        'DRAG EITHER ONE AND YOU WILL HEAR IT.',
      'sound.back': 'BACK',

      'gate.installed': 'INSTALLED',
      'gate.closed': 'CLOSED',
      'gate.missed': 'MISSED',
      'gate.time': 'TIME',
      'gate.hard': 'HARD ROUTE',
      'gate.safe': 'SAFE ROUTE',
      'gate.timeDone': '+10 SEC',
      'gate.upgrade': 'UPGRADE',

      'up.time_10': '+10 SECONDS',
      'up.time_10.label': '+10 SEC',
      'up.time_10.desc': 'Ten more seconds in the mine.',
      'up.wider_blade': 'WIDER CUTTING BLADE',
      'up.wider_blade.desc': 'Blade span +90%. Mining power +28%.',
      'up.drill_heads': 'ROTARY DRILL HEADS',
      'up.drill_heads.desc': 'Two more drill heads. Mining power +45%.',
      'up.side_grinders': 'SIDE GRINDERS',
      'up.side_grinders.desc': 'Lateral grinder discs. Wider hull, +14% power.',
      'up.mining_power': 'REINFORCED CUTTERS',
      'up.mining_power.desc': 'Mining power +55%.',
      'up.speed_up': 'TURBO DRIVE',
      'up.speed_up.desc': 'Forward speed +16%. Extra exhaust stack.',
      'up.magnet': 'MAGNETIC COLLECTORS',
      'up.magnet.desc': 'Collector arms unfold. Magnet radius +65%.',
      'up.multiplier': 'ORE REFINERY',
      'up.multiplier.desc': 'All resources are worth 1.7x more.',
      'up.rear_conveyor': 'REAR CONVEYOR',
      'up.rear_conveyor.desc': 'A collection belt sweeps up everything behind you.',
      'up.explosive_pulse': 'EXPLOSIVE PULSE',
      'up.explosive_pulse.desc': 'Periodic shockwave shatters terrain around the rig.',
      'up.overdrive': 'OVERDRIVE CORE',
      'up.overdrive.desc': 'Periodic frenzy: speed, power and magnet all surge.',
      'up.auto_hopper': 'HOPPER EXPANSION',
      'up.auto_hopper.desc': 'Storage doubled. Magnet radius +22%.',
      'up.mega_treads': 'HEAVY TREADS',
      'up.mega_treads.desc': 'Wider tracks. +12% power, +10% speed.',
      'up.final_overhaul': 'CORE BREAKER OVERHAUL',
      'up.final_overhaul.desc': 'Everything, everywhere, all at once.',

      'zone.surface': 'SURFACE CUT',
      'zone.iron': 'IRON LANES',
      'zone.granite': 'THE GRANITE WALL',
      'zone.gold': 'GOLDFIELDS',
      'zone.throat': 'THE THROAT',
      'zone.gems': 'GEM HOLLOWS',
      'zone.deep': 'DEEP BARRIER',
      'zone.crystal': 'CRYSTAL CAVERNS',
      'zone.pressure': 'PRESSURE LOCK',
      'zone.motherlode': 'THE MOTHERLODE',
      'zone.core': 'THE CORE',
      'zonekind.opening': 'SURFACE WORKINGS',
      'zonekind.rich': 'RICH SEAM',
      'zonekind.barrier': 'HARD BARRIER',
      'zonekind.narrow': 'NARROW PASS',
      'zonekind.final': 'THE MOTHERLODE',

      'mat.dirt': 'Dirt',
      'mat.stone': 'Stone',
      'mat.iron': 'Iron Ore',
      'mat.gold': 'Gold',
      'mat.gem': 'Emerald',
      'mat.crystal': 'Crystal',
      'mat.rare': 'Voidstone',
      'mat.rubble': 'Rubble',
      'mat.granite': 'Granite',
      'mat.starcore': 'Starcore',
      'mat.obsidian': 'Obsidian',
      'mat.timecell': 'Time Cell',
      'mat.boostcell': 'Boost',
      'mat.spoil': 'Spoil'
    }
  };

  function stored() {
    try {
      var v = window.localStorage.getItem(KEY);
      if (v && LANGS[v] === true) return v;
    } catch (e) { /* private mode, blocked storage: the default applies */ }
    return 'nb';
  }

  var lang = stored();
  // Before first paint: this runs from <head>, so the page never flashes English.
  document.documentElement.lang = lang;

  var warned = {};

  function t(key) {
    var v = STRINGS[lang][key];
    if (v === undefined) {
      v = STRINGS.en[key];
      if (!warned[key]) {
        warned[key] = true;
        console.warn('SUPERMINE i18n: no "' + lang + '" text for "' + key + '"');
      }
      if (v === undefined) return key;
    }
    if (typeof v === 'function') {
      return v.apply(null, Array.prototype.slice.call(arguments, 1));
    }
    return v;
  }

  function getLang() { return lang; }

  function paintStatic(root) {
    root = root || document;
    if (!root.querySelectorAll) return;
    var i, n, list;
    list = root.querySelectorAll('[data-i18n]');
    for (i = 0; i < list.length; i++) {
      n = list[i];
      var s = t(n.getAttribute('data-i18n'));
      if (n.textContent !== s) n.textContent = s;
    }
    list = root.querySelectorAll('[data-i18n-label]');
    for (i = 0; i < list.length; i++) {
      n = list[i];
      var l = t(n.getAttribute('data-i18n-label'));
      n.setAttribute('aria-label', l);
      n.setAttribute('title', l);
    }
    list = root.querySelectorAll('[data-i18n-placeholder]');
    for (i = 0; i < list.length; i++) {
      n = list[i];
      n.setAttribute('placeholder', t(n.getAttribute('data-i18n-placeholder')));
    }
  }

  function setLang(next) {
    if (LANGS[next] !== true) return;
    lang = next;
    document.documentElement.lang = lang;
    try {
      window.localStorage.setItem(KEY, lang);
    } catch (e) { /* not remembered; this visit still switches */ }
    paintStatic(document);
    var ev;
    try {
      ev = new CustomEvent('arcade:lang', { detail: lang });
    } catch (e2) {
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('arcade:lang', false, false, lang);
    }
    document.dispatchEvent(ev);
  }

  window.I18N = { t: t, getLang: getLang, setLang: setLang, paintStatic: paintStatic };
})();
