// ─── FavouritesStore ──────────────────────────────────────────────────────────
// Stores per-user bhajan favourites in Firebase Realtime Database.
//
// Data layout:
//   melody-miracle/users/{uid}/favourites/{bhajanId}: true
//
// Required Firebase DB rules (add under "melody-miracle"):
//   "users": {
//     "$uid": {
//       ".read":  "auth != null && auth.uid === $uid",
//       ".write": "auth != null && auth.uid === $uid",
//       "favourites": {
//         "$bhajanId": { ".validate": "newData.val() === true" }
//       }
//     }
//   }
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, set, remove, get, onValue,
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

const FAV_BASE = 'melody-miracle/users';

function _getApp() {
  return getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
}

export class FavouritesStore {
  constructor() {
    this._db    = null;
    this._uid   = null;
    this._ids   = new Set();
    this._unsub = null;
  }

  async load(uid, onUpdate) {
    this._uid = uid;
    this._db  = getDatabase(_getApp());
    const favRef = ref(this._db, `${FAV_BASE}/${uid}/favourites`);

    // One-time read so favourites are available immediately
    const snap = await get(favRef);
    this._ids = new Set(Object.keys(snap.val() || {}));

    // Live subscription so changes on other devices propagate
    if (this._unsub) this._unsub();
    this._unsub = onValue(favRef, snapshot => {
      this._ids = new Set(Object.keys(snapshot.val() || {}));
      onUpdate?.(this._ids);
    });

    return this._ids;
  }

  unload() {
    if (this._unsub) { this._unsub(); this._unsub = null; }
    this._uid = null;
    this._db  = null;
    this._ids = new Set();
  }

  isFavourite(bhajanId) {
    return this._ids.has(String(bhajanId));
  }

  get allIds() { return new Set(this._ids); }

  async toggle(bhajanId) {
    if (!this._uid || !this._db) return false;
    const id = String(bhajanId);
    const r  = ref(this._db, `${FAV_BASE}/${this._uid}/favourites/${id}`);
    if (this._ids.has(id)) {
      await remove(r);
      return false; // removed
    } else {
      await set(r, true);
      return true;  // added
    }
  }
}
