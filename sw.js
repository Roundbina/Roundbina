// Roundbina service worker - caches the app shell so it still works
// offline, while always preferring the freshest version when online.
const CACHE_NAME = "roundbina-cache-v3"; // bumped again - the v2 cache had been silently
// serving stale files ever since the clone() bug above started swallowing every
// network fetch into the .catch() fallback. Bumping forces one clean reset so
// everyone actually gets the fixed files instead of whatever got stuck in v2.
const APP_SHELL = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./roundbina-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for the app shell: always try to fetch the latest version
// first, and only fall back to the cached copy if the network genuinely
// fails (actually offline). This is the opposite of the old strategy
// (cache-first), which is exactly why "I uploaded new files but nothing
// changed" kept happening - cache-first ALWAYS served the old saved
// version immediately, every single load, and only refreshed the cache
// quietly in the background for next time. Since this file's own bytes
// never changed between updates, the browser had no reason to even notice
// a new service worker existed, so that stale cache never got busted on
// its own.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // BUG FIX: clone() must happen synchronously, the instant the
        // response arrives - NOT inside the nested caches.open().then().
        // caches.open() is itself async, so by the time that inner .then()
        // ran, the browser had often already started streaming
        // networkResponse's body to the page (since this whole promise
        // chain's return value goes straight to event.respondWith()).
        // Once a Response's body has started being read, .clone() throws
        // "Failed to execute 'clone' on 'Response': Response body is
        // already used" - and because that throw happened inside a .then(),
        // it was swallowed by the .catch() below, which then served the
        // OLD CACHED FILES instead of the fresh network ones. That's why
        // app.js fixes never appeared to take effect: every load was
        // silently falling back to a stale cached copy. Cloning here,
        // before any further async work, avoids the race entirely.
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
