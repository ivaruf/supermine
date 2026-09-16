/* =============================================================================
 * moved.js — the arcade changed address, and a cached page has to be told.
 *
 * Everything moved from ivaruf.github.io/<slug>/ to gophercloud.games/<slug>/.
 * GitHub redirects the old URLs, so a NEW visitor lands in the right place
 * without any help from this file. A RETURNING one never sees that redirect:
 * every game here answers a navigation from its own cache before the network
 * is consulted at all, and the sw.js update check that would replace that
 * worker now 301s to another origin, which a worker script is not allowed to
 * do. The check hard-fails, the old worker stays, and the old shell keeps
 * serving the old site for as long as the browser keeps it — no new games, no
 * fixes, and the URL they pass to a friend is the retired one.
 *
 * This runs inside that cached page and sends it on itself. It is the only
 * thing that can, which is why it has to be in the cache BEFORE the domain
 * flips: afterwards nothing new can reach these players at all.
 *
 * It PROBES before it moves anyone, which is what makes it safe to ship now,
 * days before the DNS lands. Until gophercloud.games answers, the fetch
 * rejects and this does nothing whatsoever. The moment it answers, the same
 * already-cached page carries the player across on their next visit.
 *
 * Classic deferred script, never a module — the same rule exit.js follows. A
 * module that fails takes its whole import graph down with it, and a file
 * whose job is to rescue a stranded game must not be able to break one.
 * ========================================================================== */
(function () {
  var OLD_HOST = 'ivaruf.github.io';
  var NEW_ORIGIN = 'https://gophercloud.games';

  if (location.hostname !== OLD_HOST) return;

  // Only the top window moves. A game framed by the arcade is on this same
  // retired origin, and its own copy of this file would otherwise pull the
  // IFRAME across on its own — leaving an old-origin arcade wrapped around a
  // new-origin game, which is cross-origin and breaks the quit contract. The
  // parent is running this too; let it carry the frame with it. Comparing
  // window identity is safe where reading a property of a cross-origin parent
  // is not, but the hub's rule is to guard every parent access, so: guarded.
  try {
    if (window.top !== window.self) return;
  } catch (e) {
    return;
  }

  var here = location.pathname + location.search + location.hash;

  // no-cors because we are not reading the answer, only asking whether anyone
  // is home. DNS failure and connection refusal reject; any response at all,
  // even a 404, means the new host is serving and it is safe to send people
  // there. Probing our own path rather than a fixed file keeps each game
  // asking about its own new home and depending on no other repo.
  fetch(NEW_ORIGIN + here, { mode: 'no-cors', cache: 'no-store' })
    .then(function () {
      // Hand the scope back before leaving. Not strictly required — the old
      // page would simply run this again and redirect again — but once the
      // worker is gone an old bookmark goes to the network, takes GitHub's own
      // 301 and lands natively, so the next visit needs no rescuing at all.
      //
      // Deliberately NOT caches.keys(): that is every cache on this origin,
      // and this origin is shared by seven other games. Evicting a neighbour's
      // shell is the exact accident supermine_adventure's worker documents
      // guarding against. An orphaned cache on a retired origin is harmless;
      // a deleted one belonging to a game still open in another tab is not.
      var release = navigator.serviceWorker
        ? navigator.serviceWorker.getRegistration().then(function (reg) {
            return reg ? reg.unregister() : null;
          })
        : Promise.resolve();

      return release.catch(function () {}).then(function () {
        location.replace(NEW_ORIGIN + here);
      });
    })
    .catch(function () {
      // The new home is not up yet. Stay exactly where we are and say nothing:
      // this file is allowed to do nothing, and is not allowed to be noticed.
    });
})();
