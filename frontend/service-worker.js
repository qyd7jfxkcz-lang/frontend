/* Simple offline-first service worker for the frontend demo. */

const CACHE = "iasc-pwa-v1";
const ASSETS = [
  "/frontend/index.html",
  "/frontend/assets/styles.css",
  "/frontend/assets/app.js",
  "/frontend/assets/icon.svg",
  "/frontend/assets/admin.js",
  "/frontend/admin/login.html",
  "/frontend/admin/dashboard.html",
  "/frontend/manifest.webmanifest",
  "/backend/data/data.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Network-first for dataset (so updates propagate), cache fallback for offline.
  if (url.pathname.endsWith("/backend/data/data.json")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Cache-first for app assets.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => cached))
  );
});


