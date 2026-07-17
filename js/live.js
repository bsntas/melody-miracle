// ─── LiveSession ─────────────────────────────────────────────────────────────
// Firebase Realtime Database session sharing — replaces Trystero/MQTT.
// Host-authoritative: host owns and writes state; observers subscribe via onValue.
// Firebase handles reconnection automatically — no heartbeats or retry loops needed.
//
// Data layout (entire node auto-deleted when host disconnects or ends session):
//   melody-miracle/sessions/<roomCode>/state       ← full session state (host writes)
//   melody-miracle/sessions/<roomCode>/edits/      ← observer edit queue (deleted after processing)
//   melody-miracle/sessions/<roomCode>/observers/  ← presence nodes (one per active observer)
//
// ─── One-time Firebase setup ─────────────────────────────────────────────────
// 1. Create a project at https://console.firebase.google.com
// 2. Build → Realtime Database → Create Database (any region, start in test mode)
// 3. Go to Rules tab and replace with:
//      {
//        "rules": {
//          "melody-miracle": {
//            "sessions": {
//              "$roomCode": { ".read": true, ".write": true }
//            }
//          }
//        }
//      }
// 4. Project Settings → General → Your apps → Add web app → copy values below.
//    The API key is intentionally public; security is enforced by the DB rules above.
// ─────────────────────────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:      'REPLACE_WITH_apiKey',
  databaseURL: 'https://REPLACE_WITH_projectId-default-rtdb.firebaseio.com',
  projectId:   'REPLACE_WITH_projectId',
};
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, set, push, remove,
  onValue, onChildAdded, onChildRemoved, onDisconnect,
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
  constructor({ onStateChange, onPeerChange, onError, onHostLeave }) {
    this.onStateChange = onStateChange;
    this.onPeerChange  = onPeerChange;
    this.onError       = onError;
    this.onHostLeave   = onHostLeave || null;

    this.isHost        = false;
    this.roomCode      = null;
    this._db           = null;
    this._sessionRef   = null;
    this._stateRef     = null;
    this._presenceRef  = null;  // observer-only: own presence node for host's count
    this._localState   = null;  // host-only: authoritative state copy
    this._peerCount    = 0;     // host-only: live observer count
    this._unsubs       = [];    // listener cleanup functions (returned by onValue / onChildAdded)
  }

  // ── Host: create a new live room ──────────────────────────────────────────
  host(sessionState, code) {
    this.isHost      = true;
    this.roomCode    = code;
    this._localState = { ...sessionState };

    try {
      this._db         = _getDb();
      this._sessionRef = ref(this._db, `${DB_PATH}/${code}`);
      this._stateRef   = ref(this._db, `${DB_PATH}/${code}/state`);
      const editsRef   = ref(this._db, `${DB_PATH}/${code}/edits`);
      const obsRef     = ref(this._db, `${DB_PATH}/${code}/observers`);

      // Register server-side cleanup — if host's tab closes or network drops,
      // Firebase removes the entire session node automatically.
      onDisconnect(this._sessionRef).remove();

      // Write a clean session node, then attach listeners once confirmed.
      // Attaching after the write ensures onChildAdded never fires for stale
      // edits or observers from a previous (crashed) session with the same code.
      set(this._sessionRef, { state: this._localState })
        .then(() => {
          if (!this._db) return; // host left before write finished

          const unsubObsAdd = onChildAdded(obsRef, () => {
            this._peerCount++;
            this.onPeerChange(this._peerCount);
          });
          const unsubObsRem = onChildRemoved(obsRef, () => {
            this._peerCount = Math.max(0, this._peerCount - 1);
            this.onPeerChange(this._peerCount);
          });

          // Process observer edits (setup phase only); delete each after processing.
          const unsubEdits = onChildAdded(editsRef, (snapshot) => {
            const action = snapshot.val();
            remove(snapshot.ref); // delete immediately — processed or ignored
            if (!action || this._localState?.phase !== 'setup') return;
            const next = this._applyEdit(action, this._localState);
            if (!next) return;
            this._localState = next;
            set(this._stateRef, this._localState).catch(() => {});
            this.onStateChange(this._localState);
          });

          this._unsubs.push(unsubObsAdd, unsubObsRem, unsubEdits);
        })
        .catch(e => {
          this.onError?.(`Failed to start live session: ${e.message}`);
        });

    } catch (e) {
      this.onError?.(`${e.message} — session continues offline.`);
    }

    return code;
  }

  // ── Host: update state and broadcast to all observers ────────────────────
  updateState(newState) {
    if (!this.isHost) return;
    this._localState = { ...newState };
    set(this._stateRef, this._localState).catch(() => {});
    this.onStateChange(this._localState);
  }

  // ── Host: signal session ended, then leave ────────────────────────────────
  end() {
    if (!this._sessionRef) { this._cleanup(); return; }

    // Capture refs before cleanup nullifies them
    const sessRef    = this._sessionRef;
    const stateRef   = this._stateRef;
    const finalState = { ...this._localState, phase: 'ended' };

    // Cancel the auto-remove onDisconnect, write 'ended' state so observers
    // see a clean end (not "host disconnected"), then remove after a short wait.
    onDisconnect(sessRef).cancel()
      .then(() => set(stateRef, finalState))
      .then(() => new Promise(r => setTimeout(r, 3000))) // give observers time to receive it
      .then(() => remove(sessRef))
      .catch(() => {}); // non-critical; onDisconnect will clean up on next disconnect

    this._cleanup();
  }

  // ── Observer: join a room ─────────────────────────────────────────────────
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

      const stateRef     = ref(db, `${DB_PATH}/${code}/state`);
      const obsRef       = ref(db, `${DB_PATH}/${code}/observers`);
      this._stateRef     = stateRef;

      let resolved = false;
      let hasState = false;

      // 30-second timeout — much shorter than old 45s since Firebase responds
      // immediately with null if the path doesn't exist (no MQTT handshake lag).
      const timeout = setTimeout(() => {
        if (!resolved) {
          this._cleanup();
          reject(new Error(`Session "${code}" not found — is the host running and on the same series/date?`));
        }
      }, 30000);

      const unsub = onValue(stateRef, (snapshot) => {
        const state = snapshot.val();

        if (state === null) {
          if (hasState) {
            // Node gone: host crashed or onDisconnect fired — treat as host left
            this.onHostLeave?.();
            this._cleanup();
          }
          // else: session not yet created — keep waiting for the timeout
          return;
        }

        hasState = true;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        }

        if (state.phase === 'ended') {
          this.onStateChange({ phase: 'ended' });
          this._cleanup();
          return;
        }

        this.onStateChange(state);
      });
      this._unsubs.push(unsub);

      // Write own presence so the host can show a live observer count.
      // onDisconnect ensures this is deleted even on tab close or network drop.
      const presRef     = push(obsRef, { joined: Date.now() });
      this._presenceRef = presRef;
      onDisconnect(presRef).remove();
    });
  }

  // ── Observer: send a setup-phase edit to the host ────────────────────────
  sendAction(action) {
    if (this.isHost || !this._db || !this.roomCode) return;
    push(ref(this._db, `${DB_PATH}/${this.roomCode}/edits`), action).catch(() => {});
  }

  // ── Leave (observer voluntary exit or host discard) ───────────────────────
  leave() {
    if (this._presenceRef) {
      remove(this._presenceRef).catch(() => {}); // immediate cleanup, don't wait for onDisconnect
    }
    this._cleanup();
  }

  // ─────────────────────────────────────────────────────────────────────────

  _cleanup() {
    this._unsubs.forEach(fn => fn());
    this._unsubs      = [];
    this._db          = null;
    this._sessionRef  = null;
    this._stateRef    = null;
    this._presenceRef = null;
    this._localState  = null;
    this.roomCode     = null;
    this.isHost       = false;
    this._peerCount   = 0;
  }

  _applyEdit(action, state) {
    const bhajans = state.bhajans || [];
    switch (action.type) {
      case 'add-bhajan':
        if (bhajans.some(e => e.bhajan_id === action.entry.bhajan_id)) return null;
        return { ...state, bhajans: [...bhajans, action.entry] };
      case 'remove-bhajan':
        return { ...state, bhajans: bhajans.filter(e => e.id !== action.entryId) };
      case 'reorder-bhajan': {
        const idx = bhajans.findIndex(e => e.id === action.entryId);
        if (idx < 0) return null;
        const newIdx = action.direction === 'earlier' ? idx - 1 : idx + 1;
        if (newIdx < 0 || newIdx >= bhajans.length) return null;
        const arr = [...bhajans];
        [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
        return { ...state, bhajans: arr };
      }
      case 'reorder-full': {
        const order = action.order || [];
        const byId  = Object.fromEntries(bhajans.map(e => [e.id, e]));
        const sorted  = order.map(id => byId[id]).filter(Boolean);
        const missing = bhajans.filter(e => !order.includes(e.id));
        return { ...state, bhajans: [...sorted, ...missing] };
      }
      case 'update-pitch':
        return { ...state, bhajans: bhajans.map(e => e.id === action.entryId ? {
          ...e, pitch: action.pitch,
          pitch_indian:  action.pitch_indian  || null,
          pitch_western: action.pitch_western || null,
        } : e) };
      case 'update-notes':
        return { ...state, bhajans: bhajans.map(e =>
          e.id === action.entryId ? { ...e, notes: action.notes } : e) };
      default:
        return null;
    }
  }

  get isConnected() { return !!this._db; }
}
