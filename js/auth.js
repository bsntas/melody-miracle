import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as _fbSignOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyB5ljPjYYHikxCZMFMa41oYHOHO41EeKso',
  authDomain:        'melody-miracle.firebaseapp.com',
  databaseURL:       'https://melody-miracle-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'melody-miracle',
  storageBucket:     'melody-miracle.firebasestorage.app',
  messagingSenderId: '26737059113',
  appId:             '1:26737059113:web:dd9019a0ca7f9968be0338',
};

function _getApp() {
  return getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
}

export class AuthManager {
  constructor(onUserChange) {
    this._auth = getAuth(_getApp());
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
}
