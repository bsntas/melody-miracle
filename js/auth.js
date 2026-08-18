import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as _fbSignOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, remove,
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

const PROFILE_BASE  = 'melody-miracle/users';
const CONFIG_BASE   = 'melody-miracle/config';
const REQUESTS_BASE = 'melody-miracle/access_requests';
const ADMIN_EMAIL   = 'basantanickal13@gmail.com';

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

  isAdmin() {
    return this._user?.email === ADMIN_EMAIL;
  }

  // Fetch the shared GitHub PAT from Firebase (only succeeds if this user's UID is in allowed_uids).
  async fetchGithubPat() {
    if (!this._user) return null;
    try {
      const snap = await get(ref(this._db, `${CONFIG_BASE}/github_pat`));
      return snap.val() || null;
    } catch {
      return null;
    }
  }

  // Write the shared PAT to Firebase (admin only — enforced by Security Rules).
  async setRemotePat(pat) {
    await set(ref(this._db, `${CONFIG_BASE}/github_pat`), pat);
  }

  // Record an access request so the admin can see it and grant access.
  async submitAccessRequest() {
    if (!this._user) return;
    await set(ref(this._db, `${REQUESTS_BASE}/${this._user.uid}`), {
      email:       this._user.email,
      displayName: this._user.displayName || '',
      requestedAt: new Date().toISOString(),
    });
  }

  // Admin: read all pending access requests.
  async getAccessRequests() {
    const snap = await get(ref(this._db, REQUESTS_BASE));
    const val  = snap.val() || {};
    return Object.entries(val).map(([uid, d]) => ({ uid, ...d }));
  }

  // Admin: read all currently allowed UIDs with their associated emails.
  async getAllowedUids() {
    const snap = await get(ref(this._db, `${CONFIG_BASE}/allowed_uids`));
    const val  = snap.val() || {};
    return Object.entries(val).map(([uid, email]) => ({ uid, email }));
  }

  // Admin: grant access to a UID, remove the corresponding request.
  async grantAccess(uid, email) {
    await set(ref(this._db, `${CONFIG_BASE}/allowed_uids/${uid}`), email);
    await remove(ref(this._db, `${REQUESTS_BASE}/${uid}`)).catch(() => {});
  }

  // Admin: revoke access from a UID.
  async revokeAccess(uid) {
    await remove(ref(this._db, `${CONFIG_BASE}/allowed_uids/${uid}`));
  }
}
