// ─── LiveSession ─────────────────────────────────────────────────────────────
// Firebase Realtime Database session sharing — equal-ownership model.
//
// There is no host/observer distinction at the transport layer. All participants
// read state via onValue() and write it via set() directly. The "coordinator"
// concept (who sees play controls, who saves the draft) is a UI-level decision
// enforced in app.js, not here.
//
// Why equal ownership works with Firebase:
//   Trystero/MQTT required one device to be the relay node — that was the host.
//   Firebase is already the central store; no relay is needed. Last-write-wins
//   is the conflict strategy, which is acceptable for a small same-room group
//   where concurrent conflicting edits are rare.
//
// Freeze / offline behaviour:
//   Each participant tracks their own Firebase WebSocket state via /.info/connected.
//   When a mobile browser backgrounds and drops the WebSocket, onConnectionChange(false)
//   fires so the UI can show a freeze banner and disable write actions. State
//   remains readable (Firebase client cache). onConnectionChange(true) fires on
//   reconnect and Firebase auto-delivers the latest state. No grace timers needed.
//
// Session data is never deleted on a disconnect — only on explicit end()/leave().
//
// Data layout:
//   melody-miracle/sessions/<roomCode>/state       ← full session state
//   melody-miracle/sessions/<roomCode>/observers/  ← { joined: ts } per participant
//     (no onDisconnect on observers — a backgrounded device must not reduce the count)
//
// ─── One-time Firebase setup ─────────────────────────────────────────────────
// 1. Create a project at https://console.firebase.google.com
// 2. Build → Realtime Database → Create Database (any region, start in locked mode)
// 3. Go to Rules tab and replace with:
//
//      {
//        "rules": {
//          ".read": false,
//          ".write": false,
//          "melody-miracle": {
//            "sessions": {
//              "$roomCode": {
//                ".read":  "$roomCode.matches(/^[a-z0-9][a-z0-9-]{0,60}-[0-9]{4}-[0-9]{2}-[0-9]{2}$/)",
//                ".write": "$roomCode.matches(/^[a-z0-9][a-z0-9-]{0,60}-[0-9]{4}-[0-9]{2}-[0-9]{2}$/)",
//                "state":     { ".validate": "newData.hasChildren(['phase'])" },
//                "observers": { "$uid": { ".validate": "newData.hasChildren(['joined']) && newData.child('joined').isNumber()" } }
//              }
//            }
//          }
//        }
//      }
//
//    What the rules do:
//      • Root false/false  — everything outside this app's path is locked.
//      • $roomCode regex   — only valid <series-slug>-YYYY-MM-DD codes are accepted;
//                            arbitrary paths cannot be created.
//      • .validate on state — writes must include a phase field; empty or
//                             malformed payloads are rejected.
//      • .validate on observers — presence nodes must carry a numeric joined timestamp.
//      • Deletions (null writes) bypass .validate by design — end() / leave() work fine.
//
// 4. Project Settings → General → Your apps → Add web app → copy values below.
//    The API key is intentionally public; security is enforced by the DB rules above.
//    Note: databaseURL uses a regional subdomain for non-US databases, e.g.
//    https://<projectId>-default-rtdb.asia-southeast1.firebasedatabase.app
// ─────────────────────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyB5ljPjYYHikxCZMFMa41oYHOHO41EeKso',
  authDomain:        'melody-miracle.firebaseapp.com',
  databaseURL:       'https://melody-miracle-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId:         'melody-miracle',
  storageBucket:     'melody-miracle.firebasestorage.app',
  messagingSenderId: '26737059113',
  appId:             '1:26737059113:web:dd9019a0ca7f9968be0338',
};
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, set, push, remove, get,
  onValue, onChildAdded, onChildRemoved,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const DB_PATH = 'melody-miracle/sessions';

function _getDb() {
  if (FIREBASE_CONFIG.apiKey.startsWith('REPLACE_')) {
    throw new Error('Firebase not configured — fill in FIREBASE_CONFIG in js/live.js');
  }
  const app = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
  return getDatabase(app);
}

export class LiveSession {
  constructor({ onStateChange, onPeerChange, onConnectionChange, onError }) {
    this.onStateChange      = onStateChange;
    this.onPeerChange       = onPeerChange;
    this.onConnectionChange = onConnectionChange || null;
    this.onError            = onError;

    this.isHost       = false;  // true for session coordinator; only affects app.js UI
    this.roomCode     = null;
    this.peerCount    = 0;      // live participant count (coordinator display)
    this._db           = null;
    this._stateRef     = null;
    this._presenceRef  = null;   // this participant's own presence node
    this._localState   = null;   // latest known state (used by end() for final write)
    this._unsubs       = [];     // listener cleanup functions
    this._pendingInit  = false;  // true while host() is resolving the initial get/write
    this._pendingState = null;   // state queued during _pendingInit window
  }

  // ── Coordinator: create and own the session ───────────────────────────────
  host(sessionState, code) {
    this.isHost       = true;
    this.roomCode     = code;
    this._localState  = { phase: 'setup', ...sessionState };
    this._pendingInit = true; // block updateState until the get/write resolves

    try {
      this._db       = _getDb();
      const sessRef  = ref(this._db, `${DB_PATH}/${code}`);
      this._stateRef = ref(this._db, `${DB_PATH}/${code}/state`);
      const obsRef   = ref(this._db, `${DB_PATH}/${code}/observers`);

      const attachListeners = () => {
        if (!this._db) { this._pendingInit = false; return; }
        this._pendingInit = false;
        this._watchConnection();
        // Flush any state changes queued during the _pendingInit window BEFORE attaching
        // _watchState. Doing it first means the Firebase local cache already has the
        // pending write applied, so the very first onValue echo delivers the updated
        // state — no visible flash of the old state coming back.
        if (this._pendingState) {
          this._localState = { ...this._pendingState };
          this._pendingState = null;
          try {
            set(this._stateRef, this._localState)
              .catch(e => this.onError?.(`Could not save change — ${e.message || 'network error'}`));
          } catch (e) {
            this.onError?.(`Could not save change — ${e.message || 'network error'}`);
          }
        }
        this._watchState(); // coordinator also listens so participant edits update the UI

        // Track participant count via presence nodes
        this.peerCount = 0;
        const unsubOA = onChildAdded(obsRef, () => {
          this.peerCount++;
          this.onPeerChange(this.peerCount);
        });
        const unsubOR = onChildRemoved(obsRef, () => {
          this.peerCount = Math.max(0, this.peerCount - 1);
          this.onPeerChange(this.peerCount);
        });
        this._unsubs.push(unsubOA, unsubOR);
      };

      // Check whether an active session already exists for this room code.
      // If one is found, adopt Firebase as the source of truth rather than
      // overwriting it — this preserves participant edits when the host
      // rejoins or resumes after a page reload.
      get(this._stateRef)
        .then(snap => {
          if (!this._db) { this._pendingInit = false; return; }
          const existing = snap.val();
          if (existing && existing.phase !== 'ended') {
            // Active session found — use Firebase state, skip initial write
            this._localState = { ...existing };
            attachListeners();
          } else {
            // No active session — write fresh initial state then attach listeners
            return set(sessRef, { state: this._localState }).then(attachListeners);
          }
        })
        .catch(e => {
          this._pendingInit = false;
          this.onError?.(`Failed to start live session: ${e.message}`);
        });

    } catch (e) {
      this._pendingInit = false;
      this.onError?.(`${e.message} — session continues offline.`);
    }

    return code;
  }

  // ── Participant: join an existing session ─────────────────────────────────
  join(code) {
    return new Promise((resolve, reject) => {
      this.roomCode = code;
      this.isHost   = false;

      let db;
      try {
        db       = _getDb();
        this._db = db;
      } catch (e) {
        reject(new Error(e.message));
        return;
      }

      this._stateRef = ref(db, `${DB_PATH}/${code}/state`);
      const obsRef   = ref(db, `${DB_PATH}/${code}/observers`);

      let resolved = false;
      let hasState  = false;

      // 30 s timeout. Firebase responds immediately with null when the path
      // doesn't exist, so 30 s is generous (no MQTT handshake overhead).
      const joinTimeout = setTimeout(() => {
        if (!resolved) {
          this._cleanup();
          reject(new Error(`Session "${code}" not found — check series and date`));
        }
      }, 30000);

      this._watchState((state, isNull) => {
        // Called on every state change, including null (session removed).

        if (isNull) {
          if (hasState) {
            // Session node removed: coordinator called leave() (discard).
            this.onStateChange({ phase: 'ended' });
            this._cleanup();
          }
          // else: session not yet created — keep waiting for join timeout
          return;
        }

        hasState = true;
        if (!resolved) {
          resolved = true;
          clearTimeout(joinTimeout);
          this._watchConnection();
          // Register own presence so coordinator sees an accurate count
          const presRef     = push(obsRef, { joined: Date.now() });
          this._presenceRef = presRef;
          resolve();
        }

        if (state.phase === 'ended') {
          this.onStateChange(state);
          this._cleanup();
          return;
        }

        this.onStateChange(state);
      });
    });
  }

  // ── All participants: write state directly to Firebase ────────────────────
  // Firebase's local-echo fires onValue synchronously, so all listeners
  // (including the writer's own) receive the update immediately.
  // Writes are dropped while _pendingInit is true (host() is mid-resolution).
  updateState(newState) {
    if (this._pendingInit) {
      // Queue the update; attachListeners() will flush it once Firebase is ready.
      this._pendingState = { ...newState };
      return;
    }
    this._localState = { ...newState };
    try {
      set(this._stateRef, this._localState).catch(e => {
        this.onError?.(`Could not save change — ${e.message || 'network error'}`);
      });
    } catch (e) {
      this.onError?.(`Could not save change — ${e.message || 'network error'}`);
    }
  }

  // ── Coordinator: signal session ended, then clean up ──────────────────────
  end() {
    if (!this._stateRef) { this._cleanup(); return; }

    const stateRef   = this._stateRef;
    const sessRef    = ref(this._db, `${DB_PATH}/${this.roomCode}`);
    const finalState = { ...this._localState, phase: 'ended' };

    // Write 'ended' so participants see a clean close, then remove after a
    // short wait. Non-critical: stale nodes are harmless and date-scoped.
    set(stateRef, finalState)
      .then(() => new Promise(r => setTimeout(r, 3000)))
      .then(() => remove(sessRef))
      .catch(() => {});

    this._cleanup();
  }

  // ── Leave: voluntary exit for coordinator (discard) or participant ─────────
  leave() {
    if (this._presenceRef) {
      remove(this._presenceRef).catch(() => {}); // explicit leave → immediate cleanup
    }
    if (this.isHost && this._db && this.roomCode) {
      // Coordinator discarding: remove the session so participants know it's gone
      remove(ref(this._db, `${DB_PATH}/${this.roomCode}`)).catch(() => {});
    }
    this._cleanup();
  }

  // ─────────────────────────────────────────────────────────────────────────

  // Attach onValue on stateRef. If a callback is provided it's used instead of
  // this.onStateChange (allows join() to have its own setup logic inline).
  _watchState(rawCallback) {
    const cb = rawCallback || ((state, isNull) => {
      if (isNull) return;
      this._localState = { ...state };
      this.onStateChange(state);
    });

    const unsub = onValue(this._stateRef, (snapshot) => {
      const state = snapshot.val();
      cb(state, state === null);
    });
    this._unsubs.push(unsub);
  }

  // Track this device's own Firebase WebSocket connection.
  // onConnectionChange(true/false) lets the UI show a freeze banner when offline.
  _watchConnection() {
    if (!this._db || !this.onConnectionChange) return;
    const unsub = onValue(ref(this._db, '.info/connected'), (snap) => {
      this.onConnectionChange(!!snap.val());
    });
    this._unsubs.push(unsub);
  }

  _cleanup() {
    this._unsubs.forEach(fn => fn());
    this._unsubs      = [];
    this._db          = null;
    this._stateRef    = null;
    this._presenceRef = null;
    this._localState   = null;
    this._pendingState = null;
    this.roomCode      = null;
    this.isHost        = false;
    this.peerCount     = 0;
    this._pendingInit  = false;
  }

  get isConnected() { return !!this._db; }
}

// ── List currently open sessions ───────────────────────────────────────────
// Probes each room code with a one-time read and returns those whose state
// exists and has not ended. Uses the existing per-roomCode Firebase rules —
// no extra permissions required.
export async function listOpenSessions(roomCodes) {
  if (!roomCodes.length) return [];
  let db;
  try { db = _getDb(); } catch { return []; }

  const results = await Promise.allSettled(
    roomCodes.map(async code => {
      const snap = await get(ref(db, `${DB_PATH}/${code}/state`));
      const state = snap.val();
      if (!state || state.phase === 'ended') return null;
      return { code, state };
    })
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value !== null)
    .map(r => r.value);
}
