// ─── Firebase Messaging (background push) ────────────────────────────────────
// Must be at the top — importScripts runs synchronously before any event handler.
// Uses the compat SDK because service workers cannot use ES module imports.
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyB5ljPjYYHikxCZMFMa41oYHOHO41EeKso',
  authDomain:        'melody-miracle.firebaseapp.com',
  databaseURL:       'https://melody-miracle-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'melody-miracle',
  storageBucket:     'melody-miracle.firebasestorage.app',
  messagingSenderId: '26737059113',
  appId:             '1:26737059113:web:dd9019a0ca7f9968be0338',
});

const messaging = firebase.messaging();

// Called when a push arrives and the app is in the background or closed.
// Firebase handles the `push` event internally; this callback just customises the notification.
messaging.onBackgroundMessage(payload => {
  const n    = payload.notification || {};
  const data = payload.data       || {};
  return self.registration.showNotification(n.title || 'Melody Miracle', {
    body:  n.body  || '',
    icon:  './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data:  { url: data.url || './', ...data },
    tag:   data.tag || 'melody-miracle-push',
    renotify: true,
  });
});

// Clicking the OS notification opens or focuses the app window.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          return client.navigate(url).then(c => c.focus()).catch(() => client.focus());
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ─── Melody Miracle Service Worker ───────────────────────────────────────────
// Cache version — bump this string whenever assets change (same cadence as ?v= query strings).
const CACHE = 'melody-miracle-20260915.3';

// Per-file version strings — must match exactly what index.html and app.js request.
const V_APP        = '20260915.3'; // app.js (FCM push: uid + initPush wired)
const V_GH         = '20260903.1'; // github-store.js (unchanged)
const V_CSS        = '20260915.1'; // style.css (notification bell, badge, panel styles)
const V_FUNDS_LIVE = '20260903.1'; // funds-live.js (unchanged)
const V_AUTH       = '20260818.3'; // auth.js (unchanged)
const V_LIVE       = '20260816.2'; // live.js (unchanged)
const V_CORE       = '20260807.3'; // store.js (unchanged)
const V_FAV        = '20260806.2'; // favourites.js (unchanged)
const V_NOTIF      = '20260915.2'; // notifications.js (FCM initPush support)
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
  `./js/funds-live.js?v=${V_FUNDS_LIVE}`,
  `./js/notifications.js?v=${V_NOTIF}`,
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
