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

const VERSION = 'v1.2.0';
const CACHE = `supermine-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './style.css',
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
