// ─── FundsLive ────────────────────────────────────────────────────────────────
// Firebase real-time store for pending funds submissions.
//
// DB path: melody-miracle/funds/pending/<pushId>
//
// Firebase Realtime Database rules — add this block alongside the existing
// "sessions" block inside "melody-miracle":
//
//   "funds": {
//     "pending": {
//       ".read": true,
//       ".write": true
//     }
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, push, set, remove, get,
  onChildAdded, onChildRemoved,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyB5ljPjYYHikxCZMFMa41oYHOHO41EeKso',
  authDomain:        'melody-miracle.firebaseapp.com',
  databaseURL:       'https://melody-miracle-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'melody-miracle',
  storageBucket:     'melody-miracle.firebasestorage.app',
  messagingSenderId: '26737059113',
  appId:             '1:26737059113:web:dd9019a0ca7f9968be0338',
};

const FUNDS_PENDING_PATH = 'melody-miracle/funds/pending';

function _getDb() {
  const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
  return getDatabase(app);
}

export class FundsLive {
  constructor({ onPendingAdded, onPendingRemoved } = {}) {
    this.onPendingAdded   = onPendingAdded   || null;
    this.onPendingRemoved = onPendingRemoved || null;
    this._unsubs = [];
  }

  // Member submits a pending payment receipt.
  async submitPayment(data) {
    const db  = _getDb();
    const ref_ = push(ref(db, FUNDS_PENDING_PATH));
    await set(ref_, { ...data, id: ref_.key });
    return ref_.key;
  }

  // One-shot fetch of all pending entries.
  async getAll() {
    const snap = await get(ref(_getDb(), FUNDS_PENDING_PATH));
    if (!snap.exists()) return [];
    return Object.entries(snap.val() || {}).map(([key, val]) => ({ ...val, id: key }));
  }

  // Listen for new/removed pending entries in real time (cashier view).
  listen() {
    const pendingRef = ref(_getDb(), FUNDS_PENDING_PATH);
    this._unsubs.push(
      onChildAdded(pendingRef, snap => {
        if (snap.val()) this.onPendingAdded?.(snap.key, { ...snap.val(), id: snap.key });
      })
    );
    this._unsubs.push(
      onChildRemoved(pendingRef, snap => {
        this.onPendingRemoved?.(snap.key);
      })
    );
  }

  // Remove a pending entry after approve or reject.
  async removePending(id) {
    await remove(ref(_getDb(), `${FUNDS_PENDING_PATH}/${id}`));
  }

  destroy() {
    this._unsubs.forEach(fn => fn());
    this._unsubs = [];
  }
}
