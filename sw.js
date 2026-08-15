// ─── Melody Miracle Service Worker ───────────────────────────────────────────
// Cache version — bump this string whenever assets change (same cadence as ?v= query strings).
const CACHE = 'melody-miracle-20260815.24';

// Per-file version strings — must match exactly what index.html and app.js request.
const V_APP  = '20260815.24'; // app.js (Aarti visible to all in play mode; hidden in setup)
const V_GH   = '20260811.1';  // github-store.js (unchanged)
const V_CSS  = '20260815.20'; // style.css (float-ctrl-btn flex layout for SVG icons)
const V_AUTH = '20260807.1'; // auth.js (unchanged)
const V_LIVE = '20260811.3'; // live.js (unchanged)
const V_CORE = '20260807.3'; // store.js (unchanged)
const V_FAV  = '20260806.2'; // favourites.js (unchanged)
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  `./css/style.css?v=${V_CSS}`,
  `./js/app.js?v=${V_APP}`,
  `./js/store.js?v=${V_CORE}`,
  `./js/github-store.js?v=${V_GH}`,
  `./js/live.js?v=${V_LIVE}`,
  `./js/auth.js?v=${V_AUTH}`,
  `./js/favourites.js?v=${V_FAV}`,
  './icons/icon-192.png',
  './icons/icon-512.png',
  './favicon.png',
];

// ── Install: pre-cache the app shell ─────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: delete stale caches, then tell open windows to reload ───────────
// postMessage is used instead of client.navigate() because navigate() can fail
// silently in installed PWA contexts. The page listens for SW_UPDATED and calls
// window.location.reload() itself, which always works.
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => {
        const stale = keys.filter(k => k !== CACHE);
        const isUpdate = stale.length > 0;
        return Promise.all(stale.map(k => caches.delete(k)))
          .then(() => self.clients.claim())
          .then(() => {
            if (!isUpdate) return;
            return self.clients.matchAll({ type: 'window' }).then(clients =>
              Promise.all(clients.map(c => c.postMessage({ type: 'SW_UPDATED' })))
            );
          });
      })
  );
});

// ── Fetch strategy ────────────────────────────────────────────────────────────
// Data files (bhajans.json, sessions.json): network-first so updates are seen immediately.
// Everything else: cache-first for offline reliability.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  const isData = url.pathname.endsWith('.json') && url.pathname.includes('/data/');

  if (isData) {
    // Network-first: fresh data when online, fall back to cache when offline.
    e.respondWith(
      fetch(e.request)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
  } else {
    // Cache-first: fast loads, works offline.
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request))
    );
  }
});
