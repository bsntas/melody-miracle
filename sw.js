// ─── Melody Miracle Service Worker ───────────────────────────────────────────
// Cache version — bump this string whenever assets change (same cadence as ?v= query strings).
const CACHE = 'melody-miracle-20260705';

// App shell: always cached on install.
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/store.js',
  './js/github-store.js',
  './js/live.js',
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

// ── Activate: delete stale caches ────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
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
