// ─── LiveSession ─────────────────────────────────────────────────────────────
// Firebase Realtime Database session sharing.
// Host-authoritative: host owns and writes state; observers subscribe via onValue.
// Firebase handles reconnection automatically — no heartbeats or retry loops.
//
// Mobile disconnect handling:
//   Mobile browsers drop the WebSocket whenever the app is backgrounded.
//   We NEVER delete session data on a disconnect. Instead the host presence
//   node is set to { online: false } (via onDisconnect), and observers start
//   a 2-minute grace timer before declaring the host gone. If the host comes
//   back within that window, the timer is cancelled and the session continues
//   uninterrupted. Session data is only removed on explicit end() / leave().
//
// Data layout:
//   melody-miracle/sessions/<roomCode>/state       ← full session state
//   melody-miracle/sessions/<roomCode>/host        ← { online: bool } presence flag
//   melody-miracle/sessions/<roomCode>/edits/      ← observer edit queue (deleted after processing)
//   melody-miracle/sessions/<roomCode>/observers/  ← { joined: ts } one per active observer
//
// ─── One-time Firebase setup ─────────────────────────────────────────────────
// 1. Create a project at https://console.firebase.google.com
// 2. Build → Realtime Database → Create Database (any region, test mode to start)
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

const DB_PATH  = 'melody-miracle/sessions';
const GRACE_MS = 120_000; // 2 min grace before declaring host gone after a disconnect

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

    this.isHost       = false;
    this.roomCode     = null;
    this.peerCount    = 0;     // public: host shows live observer count
    this._db          = null;
    this._sessionRef  = null;
    this._stateRef    = null;
    this._hostRef     = null;  // sessions/<code>/host — presence flag only
    this._presenceRef = null;  // observer-only: own presence node
    this._localState  = null;  // host-only: authoritative state copy
    this._graceTimer  = null;  // observer-only: fires onHostLeave after GRACE_MS
    this._unsubs      = [];    // listener cleanup functions
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
      this._hostRef    = ref(this._db, `${DB_PATH}/${code}/host`);
      const editsRef   = ref(this._db, `${DB_PATH}/${code}/edits`);
      const obsRef     = ref(this._db, `${DB_PATH}/${code}/observers`);

      // Write a clean session node (clears any stale data from a previous session
      // with the same room code), then attach listeners once confirmed.
      set(this._sessionRef, { state: this._localState })
        .then(() => {
          if (!this._db) return; // host left before write finished

          // ── Host presence via /.info/connected ──────────────────────────
          // This is Firebase's canonical reconnect pattern. On every (re)connect
          // we re-register onDisconnect and write online:true. onDisconnect only
          // sets a flag — it never deletes session data — so a mobile background
          // pause does not destroy the session.
          const connRef = ref(this._db, '.info/connected');
          const unsubConn = onValue(connRef, (snap) => {
            if (!snap.val() || !this._db) return;
            // Reconnected: re-register the soft disconnect marker and go online
            onDisconnect(this._hostRef).set({ online: false });
            set(this._hostRef, { online: true });
          });
          this._unsubs.push(unsubConn);

          // ── Observer count via presence nodes ────────────────────────────
          // Observers push a presence node on join and remove it on explicit
          // leave(). We do NOT use onDisconnect for observer presence — a
          // backgrounded observer should not decrement the count. The count
          // may be slightly stale after a crash but that is acceptable.
          this.peerCount = 0;
          const unsubOA = onChildAdded(obsRef, () => {
            this.peerCount++;
            this.onPeerChange(this.peerCount);
          });
          const unsubOR = onChildRemoved(obsRef, () => {
            this.peerCount = Math.max(0, this.peerCount - 1);
            this.onPeerChange(this.peerCount);
          });

          // ── Observer edit queue ──────────────────────────────────────────
          const unsubEdits = onChildAdded(editsRef, (snapshot) => {
            const action = snapshot.val();
            remove(snapshot.ref); // delete immediately after reading
            if (!action || this._localState?.phase !== 'setup') return;
            const next = this._applyEdit(action, this._localState);
            if (!next) return;
            this._localState = next;
            set(this._stateRef, this._localState).catch(() => {});
            this.onStateChange(this._localState);
          });

          this._unsubs.push(unsubOA, unsubOR, unsubEdits);
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

    // Capture refs before _cleanup() nullifies them
    const sessRef    = this._sessionRef;
    const stateRef   = this._stateRef;
    const hostRef    = this._hostRef;
    const finalState = { ...this._localState, phase: 'ended' };

    // Cancel the soft-offline marker so it doesn't fire during our cleanup,
    // write the 'ended' state so observers see a clean end (not "host disconnected"),
    // then remove the session node after a short wait.
    onDisconnect(hostRef).cancel()
      .then(() => set(stateRef, finalState))
      .then(() => new Promise(r => setTimeout(r, 3000)))
      .then(() => remove(sessRef))
      .catch(() => {}); // non-critical; stale node is harmless and date-scoped

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

      const stateRef   = ref(db, `${DB_PATH}/${code}/state`);
      const hostRef    = ref(db, `${DB_PATH}/${code}/host`);
      const obsRef     = ref(db, `${DB_PATH}/${code}/observers`);
      this._stateRef   = stateRef;

      let resolved = false;
      let hasState = false;

      // 30 s join timeout. Firebase responds immediately with null if the path
      // doesn't exist (no MQTT handshake lag), so 30 s is plenty.
      const joinTimeout = setTimeout(() => {
        if (!resolved) {
          this._cleanup();
          reject(new Error(`Session "${code}" not found — is the host running and on the same series/date?`));
        }
      }, 30000);

      // ── State listener ───────────────────────────────────────────────────
      const unsubState = onValue(stateRef, (snapshot) => {
        const state = snapshot.val();

        if (state === null) {
          if (hasState) {
            // Node gone: host called leave() (explicit discard). The host-went-
            // offline path is handled separately via the host presence listener.
            this._cancelGrace();
            this.onHostLeave?.();
            this._cleanup();
          }
          // else: session not yet created — keep waiting for the join timeout
          return;
        }

        hasState = true;
        if (!resolved) {
          resolved = true;
          clearTimeout(joinTimeout);
          resolve();
        }

        if (state.phase === 'ended') {
          this._cancelGrace();
          this.onStateChange({ phase: 'ended' });
          this._cleanup();
          return;
        }

        this.onStateChange(state);
      });
      this._unsubs.push(unsubState);

      // ── Host presence listener (grace-period disconnect detection) ────────
      // When host goes offline (mobile background, network drop) onDisconnect
      // sets host.online = false. We wait GRACE_MS before acting — if the host
      // reconnects within that window we cancel the timer and stay in session.
      // Only start the grace timer once we've confirmed the session exists
      // (hasState = true), so a temporarily-offline host at join time is fine.
      const unsubHost = onValue(hostRef, (snap) => {
        const h = snap.val();
        if (!h) return; // host presence not written yet

        if (h.online === true) {
          // Host is (back) online — cancel any running grace timer
          this._cancelGrace();
        } else if (h.online === false && hasState && !this._graceTimer) {
          // Host went offline. Start grace period before declaring them gone.
          this._graceTimer = setTimeout(() => {
            this._graceTimer = null;
            this.onHostLeave?.();
            this._cleanup();
          }, GRACE_MS);
        }
      });
      // Wrap so _cleanup() also cancels the grace timer
      this._unsubs.push(() => { this._cancelGrace(); unsubHost(); });

      // ── Own presence node ────────────────────────────────────────────────
      // Pushed on join; removed on explicit leave(). We deliberately do NOT
      // register onDisconnect here — a backgrounded observer should not
      // decrement the host's count. Slight over-count on crash is acceptable.
      const presRef     = push(obsRef, { joined: Date.now() });
      this._presenceRef = presRef;
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
      remove(this._presenceRef).catch(() => {}); // explicit leave → remove presence immediately
    }
    if (this.isHost && this._sessionRef) {
      // Host discard: remove the session node so observers know the session is gone
      remove(this._sessionRef).catch(() => {});
    }
    this._cleanup();
  }

  // ─────────────────────────────────────────────────────────────────────────

  _cancelGrace() {
    if (this._graceTimer) {
      clearTimeout(this._graceTimer);
      this._graceTimer = null;
    }
  }

  _cleanup() {
    this._cancelGrace();
    this._unsubs.forEach(fn => fn());
    this._unsubs      = [];
    this._db          = null;
    this._sessionRef  = null;
    this._stateRef    = null;
    this._hostRef     = null;
    this._presenceRef = null;
    this._localState  = null;
    this.roomCode     = null;
    this.isHost       = false;
    this.peerCount    = 0;
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
        const order  = action.order || [];
        const byId   = Object.fromEntries(bhajans.map(e => [e.id, e]));
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
