import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as _fbSignOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getDatabase, ref, get, set,
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

const PROFILE_BASE = 'melody-miracle/users';

function _getApp() {
  return getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
}

export class AuthManager {
  constructor(onUserChange) {
    const app  = _getApp();
    this._auth = getAuth(app);
    this._db   = getDatabase(app);
    this._user = null;
    onAuthStateChanged(this._auth, user => {
      this._user = user;
      onUserChange(user);
    });
  }

  get currentUser() { return this._user; }

  async signIn() {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(this._auth, provider);
  }

  async signOut() {
    await _fbSignOut(this._auth);
  }

  async loadProfile(uid) {
    try {
      const snap = await get(ref(this._db, `${PROFILE_BASE}/${uid}/profile`));
      return snap.val() || null;
    } catch {
      return null;
    }
  }

  async saveProfile(uid, data) {
    await set(ref(this._db, `${PROFILE_BASE}/${uid}/profile`), data);
  }
}
