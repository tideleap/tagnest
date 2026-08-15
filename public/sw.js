// TagNest service worker — an offline-app-shell PWA.
//
// Strategy (deliberately conservative for a data + auth app):
//   - PRECACHE  the static shell + manifest so the UI opens offline.
//   - STATIC    /assets/* and images: stale-while-revalidate (instant second
//               load, always refreshes behind the scenes).
//   - NAVIGATION requests: serve the cached index.html shell when offline,
//               otherwise hit the network (so the served HTML stays current).
//   - API       /api/* is NEVER cached: bookmark data is user-specific and
//               must not be served stale across accounts/sessions.
//
// Versioning: bump CACHE_VERSION on any change to force a clean cache, and
// skipWaiting + clientsClaim give a new SW control on the next load.
//
// v4: manifest.webmanifest gained share_target + indigo theme colours (B-3);
// the precached copy must be refreshed so installed PWAs pick up the Web Share
// Target registration.
const CACHE_VERSION = 'tagnest-shell-v4';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/pwa-icon-192.png',
  '/pwa-icon-512.png',
];

const STATIC_PREFIXES = ['/assets/'];
const IMAGE_PREFIXES = ['/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // POST/PATCH/DELETE: never intercept

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // avoid third-party cache poisoning

  // 1. API — network only, no cache fallback.
  if (url.pathname.startsWith('/api/')) {
    return; // default network behaviour
  }

  const isStatic = STATIC_PREFIXES.some((p) => url.pathname.startsWith(p));
  const isImage = IMAGE_PREFIXES.some((p) => url.pathname.startsWith(p));
  const isNavigation = request.mode === 'navigate';

  // 2. Static assets + images — stale-while-revalidate.
  if (isStatic || isImage) {
    event.respondWith(swr(request));
    return;
  }

  // 3. Navigation — network first, offline shell fallback.
  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put('/index.html', copy));
          return res;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || Response.error()),
        ),
    );
  }
});

/** Stale-while-revalidate: return cached instantly, refresh in background. */
function swr(request) {
  const cachePromise = caches.open(CACHE_VERSION);
  return cachePromise.then((cache) =>
    cache.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
}
