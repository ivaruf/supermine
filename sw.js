/* =============================================================================
 * SUPERMINE service worker — offline play, installable, OPT-IN updates.
 * -----------------------------------------------------------------------------
 * UPDATE MODEL
 *   Bump VERSION on every deploy. The page registers with
 *   { updateViaCache: 'none' } and calls reg.update() on load, so a changed
 *   sw.js is noticed at launch and the new build is precached in the
 *   background. The new worker then WAITS — it does NOT take over. ui.js shows
 *   an "UPDATE READY" button on the MENU, and only that tap sends SKIP_WAITING.
 *   When the new worker takes control, ui.js reloads — and only ever from the
 *   menu, never mid-run, so a 60-second attempt can't be destroyed by a deploy.
 *
 *   GET_VERSION lets the menu display the build that is actually serving this
 *   session, rather than whatever string happens to be compiled into the page.
 *
 * WHY CACHE-FIRST, WHOLE-BUILD
 *   SUPERMINE is 14 classic <script> tags sharing one global `SM`, with a
 *   documented cross-module contract. Serving js/ui.js from a new deploy
 *   alongside js/level.js from an old one would break that contract in ways
 *   that are almost impossible to debug. One versioned cache per deploy means
 *   every file in a session comes from exactly ONE build.
 *
 * ALL PATHS ARE RELATIVE ('./x') so the app works from a GitHub Pages
 * subpath like /supermine/ as well as from a domain root.
 * ========================================================================== */

// Bump on EVERY deploy — this string is the whole update mechanism. Clients
// that already have a cache only notice a new build when VERSION changes.
// v1.3.0  PWA + service worker, FREESTYLE mode, rebuilt main menu
// v1.4.0  mobile/portrait camera fit (the lane no longer runs off the sides)
// v1.5.0  mobile HUD rebuild: full-width score row, centred clock, icon
//         buttons, pause menu, on-screen steering pads, progress gauge gone;
//         portrait now frames the WHOLE lane by solving the terrain grid
//         pitch against the particle pool instead of capping the zoom
// v1.6.0  ADVENTURE MODE: save slots, world map, mining rights, fuel + cargo
//         pressure, workshop upgrades, free 2D driving on a translucent
//         joystick, persistent per-mine tunnels
// v1.6.1  Adventure fixes: refuelling a part-full tank, the full-hold collect
//         loop, finite dumped-ore heaps, FUNDS on the in-mine HUD, and a
//         one-tap SELL / REFUEL / BACK TO MINE surface loop.
//         BUMPED DELIBERATELY: this cache is whole-build and cache-first, so a
//         client that installed v1.6.0 keeps being served v1.6.0 for every file
//         until this string changes — which is exactly how a new HUD ends up
//         reading a getter an older adv.js does not export yet.
// v1.6.2  Mines 3x deeper and ~3x wider (5200 units across) on 2D chunked
//         streaming; cargo doubles per tier; starter tank nerfed; tracks now
//         gate the engine; redesigned cargo + drill visuals; slower drilling
//         with a fast travel gear
// v1.6.3  Scanner draws labelled arrows out of the machine, ranked by what the
//         ore is WORTH rather than by signal strength; mobile HUD moved off the
//         top of the screen onto side rails so the shaft and the mine mouth are
//         visible while climbing out.
// v1.6.4  Compact HUD revision 2: FUEL back on the top bar at half width, HOLD
//         as a translucent box over the bottom readout. The full-height edge
//         rails of v1.6.3 cleared the shaft but were far too much furniture.
// v1.6.5  The whole hold is always visible (no collapse drawer); a parked
//         machine burns NO fuel, so thinking is free; worklights and festoon
//         bulbs at the mine mouth mark the exit and make the surface a worksite.
// v1.6.6  Compact HUD is ONE info bar: FUEL (narrower) butted against HULL and
//         DEPTH side by side, the company balance on its own line under the
//         sound and pause plates, and the hold alone at the bottom.
// v1.6.7  Cache-bust only. v1.6.6 already contained the side-by-side HULL and
//         DEPTH layout, but this cache is whole-build and cache-first, so a
//         client sitting on an older version keeps being served it until this
//         string changes. Bumped on request to force the update prompt.
const VERSION = 'v1.6.7';
const CACHE = `supermine-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './style.css',
  './style-adventure.css',
  './js/config.js',
  './js/events.js',
  './js/materials.js',
  './js/input.js',
  './js/camera.js',
  './js/particles.js',
  './js/terrain.js',
  './js/vehicle.js',
  './js/upgrades.js',
  './js/level.js',
  './js/effects.js',
  './js/sound.js',
  './js/ui.js',
  './js/mines.js',
  './js/rig.js',
  './js/save.js',
  './js/advterrain.js',
  './js/scanner.js',
  './js/joystick.js',
  './js/advhud.js',
  './js/advui.js',
  './js/adv.js',
  './js/main.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  // Deliberately NO skipWaiting(): once precached the new worker parks in
  // WAITING until the player accepts the update from the menu.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'SKIP_WAITING') self.skipWaiting();
  if (msg.type === 'GET_VERSION' && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION });
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('supermine-') && k !== CACHE)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => (request.mode === 'navigate' ? caches.match('./index.html') : undefined));
    })
  );
});
