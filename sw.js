// ─── Melody Miracle Service Worker ───────────────────────────────────────────
// Cache version — bump this string whenever assets change (same cadence as ?v= query strings).
const CACHE = 'melody-miracle-20260817.26';

// Per-file version strings — must match exactly what index.html and app.js request.
const V_APP  = '20260817.25'; // app.js (resumeBgSession: remove entry from _bgSessions to clear tab badge)
const V_GH   = '20260817.15'; // github-store.js (deleteSeries: skip commitToGitHub if no sessions removed; remove from _knownSeries; update series index)
const V_CSS  = '20260817.8'; // style.css (hide red live-dot when count badge is visible)
const V_AUTH = '20260807.1'; // auth.js (unchanged)
const V_LIVE = '20260816.2'; // live.js (reconnect() method via goOffline/goOnline)
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
// Use cache:'reload' so every install always fetches from the server, bypassing
// any HTTP/CDN cache. Without this, a stale CDN response for index.html could
// be baked into the new SW cache even after the version string has changed.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' }))))
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
