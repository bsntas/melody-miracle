// ─── NotificationCenter ────────────────────────────────────────────────────────
// Firebase-backed in-app + OS push notification system.
//
// DB paths:
//   melody-miracle/notifications/<emailSlug>/<pushKey>  — per-user (email-keyed)
//   melody-miracle/broadcasts/<pushKey>                 — global (session started, etc.)
//   melody-miracle/fcm-tokens/<emailSlug>/<uid>         — FCM device tokens per user
//
// Required Firebase Realtime Database rules — add inside "melody-miracle" in Rules tab:
//
//   "notifications": {
//     "$emailSlug": { ".read": true, ".write": true }
//   },
//   "broadcasts": { ".read": true, ".write": true },
//   "fcm-tokens": {
//     "$emailSlug": { ".read": false, ".write": true }
//   }
//
// Required setup for system (OS) push notifications:
//   1. Firebase Console → Project Settings → Cloud Messaging → Web configuration
//      → Generate a key pair and paste its "Key pair" value as VAPID_KEY below.
//   2. Deploy the Cloud Function in functions/index.js (see that file for instructions).
//
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, push, set, update,
  onChildAdded, query, orderByChild, limitToLast,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import {
  getMessaging, getToken, onMessage,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js';

// ── Replace with your VAPID key from Firebase Console → Project Settings
//    → Cloud Messaging → Web configuration → Key pairs → Generate / show key pair
export const VAPID_KEY = 'REPLACE_WITH_YOUR_FIREBASE_VAPID_KEY';

const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyB5ljPjYYHikxCZMFMa41oYHOHO41EeKso',
  authDomain:        'melody-miracle.firebaseapp.com',
  databaseURL:       'https://melody-miracle-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'melody-miracle',
  storageBucket:     'melody-miracle.firebasestorage.app',
  messagingSenderId: '26737059113',
  appId:             '1:26737059113:web:dd9019a0ca7f9968be0338',
};

const NOTIF_PATH     = 'melody-miracle/notifications';
const BROADCAST_PATH = 'melody-miracle/broadcasts';
const TOKEN_PATH     = 'melody-miracle/fcm-tokens';

function _getApp() {
  return getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
}
function _getDb() { return getDatabase(_getApp()); }

export function emailToSlug(email) {
  return email.toLowerCase().replace(/[@.+]/g, '_');
}

export class NotificationCenter {
  constructor({ email, uid, onNew, onUnreadChange }) {
    this.email          = email;
    this.uid            = uid || null;
    this.onNew          = onNew;
    this.onUnreadChange = onUnreadChange;
    this._slug          = email ? emailToSlug(email) : null;
    this._items         = {};
    this._unsubs        = [];
    this._attachedAt    = 0;
  }

  // ── In-app realtime listener ──────────────────────────────────────────────

  attach() {
    this._attachedAt = Date.now();
    try {
      const db = _getDb();

      if (this._slug) {
        const userQ = query(
          ref(db, `${NOTIF_PATH}/${this._slug}`),
          orderByChild('createdAt'),
          limitToLast(30)
        );
        this._unsubs.push(onChildAdded(userQ, snap => this._ingest(snap, false)));
      }

      const bcastQ = query(
        ref(db, BROADCAST_PATH),
        orderByChild('createdAt'),
        limitToLast(20)
      );
      this._unsubs.push(onChildAdded(bcastQ, snap => this._ingest(snap, true)));

    } catch (e) {
      console.warn('[Notifications] Firebase attach failed:', e.message);
    }
  }

  _ingest(snap, isBroadcast) {
    const val = snap.val();
    if (!val) return;
    if (this._items[snap.key]) return;
    const item = { key: snap.key, isBroadcast, read: false, ...val };
    this._items[snap.key] = item;
    const isNew = item.createdAt > this._attachedAt;
    if (isNew) this.onNew?.(item);
    this.onUnreadChange?.(this.unreadCount);
  }

  get unreadCount() {
    return Object.values(this._items).filter(i => !i.read).length;
  }

  get items() {
    return Object.values(this._items)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  markRead(key) {
    const item = this._items[key];
    if (!item || item.read) return;
    item.read = true;
    this.onUnreadChange?.(this.unreadCount);
    if (!item.isBroadcast && this._slug) {
      try {
        update(ref(_getDb(), `${NOTIF_PATH}/${this._slug}/${key}`), { read: true }).catch(() => {});
      } catch {}
    }
  }

  markAllRead() {
    Object.values(this._items).forEach(i => { i.read = true; });
    this.onUnreadChange?.(0);
  }

  detach() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
    this._items  = {};
  }

  // ── FCM push token registration ───────────────────────────────────────────
  // Call this after the user has granted Notification permission.
  // Gets this device's FCM token and stores it in the DB so the Cloud Function
  // can send OS pushes to it. Safe to call on every sign-in — overwrites the
  // same slot if the token hasn't changed.

  async initPush(vapidKey) {
    if (!vapidKey || vapidKey.startsWith('REPLACE_')) {
      console.info('[Push] VAPID key not set — OS push notifications disabled. Set VAPID_KEY in js/notifications.js.');
      return;
    }
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!this._slug || !this.uid) return;

    try {
      const swReg = await navigator.serviceWorker.ready;
      const token = await getToken(getMessaging(_getApp()), {
        vapidKey,
        serviceWorkerRegistration: swReg,
      });
      if (!token) return;
      // Store: melody-miracle/fcm-tokens/<emailSlug>/<uid> = token
      await set(ref(_getDb(), `${TOKEN_PATH}/${this._slug}/${this.uid}`), token);

      // Handle foreground messages (app is open and focused) — show in-app only
      onMessage(getMessaging(_getApp()), payload => {
        const n = payload.notification || {};
        this.onNew?.({
          key:         `fcm-${Date.now()}`,
          isBroadcast: false,
          read:        false,
          type:        payload.data?.type || 'push',
          title:       n.title || 'Melody Miracle',
          body:        n.body  || '',
          createdAt:   Date.now(),
        });
        this.onUnreadChange?.(this.unreadCount + 1);
      });

      console.info('[Push] FCM token registered for OS notifications');
    } catch (e) {
      console.warn('[Push] FCM token registration failed:', e.message);
    }
  }

  // ── Static senders ────────────────────────────────────────────────────────

  static async notify(toEmail, notif) {
    if (!toEmail) return;
    try {
      const db   = _getDb();
      const slug = emailToSlug(toEmail);
      const r    = push(ref(db, `${NOTIF_PATH}/${slug}`));
      await set(r, { ...notif, createdAt: Date.now(), read: false });
    } catch { /* non-critical */ }
  }

  static async broadcast(notif) {
    try {
      const db = _getDb();
      const r  = push(ref(db, BROADCAST_PATH));
      await set(r, { ...notif, createdAt: Date.now() });
    } catch { /* non-critical */ }
  }
}
