// Roundbina service worker - caches the app shell so it still works
// offline, while always preferring the freshest version when online.
const CACHE_NAME = "roundbina-cache-v2"; // bumped - forces one clean cache reset
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
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse.clone()));
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
