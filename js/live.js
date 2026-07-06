// ─── LiveSession ─────────────────────────────────────────────────────────────
// Trystero-based real-time bhajan session sharing.
// Host-authoritative: host holds state and broadcasts to all observers.
// In setup phase, observers can send edit actions back to the host.
//
// Robustness model:
//  - Host broadcasts state every 10s (heartbeat) and on every state change.
//  - Observer pings hello every 5s until it receives its first state (handles
//    MQTT packet loss on initial join). After connected, pings every 20s so
//    it stays in sync even if a heartbeat is lost.
//  - Observer tracks which peer IS the host (via the first state/ended message).
//    onPeerLeave is only acted on if THAT specific peer left — not other observers.
//  - If the host peer leaves, an 8s grace window lets a WiFi flap recover
//    silently (state stays on screen). Only after 8s without a returning state
//    message does onHostLeave fire.

import { joinRoom } from 'https://esm.sh/trystero@0.21.0/mqtt';

const APP_ID     = 'bsntas-melody-miracle-v1';
const BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';

function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export class LiveSession {
  constructor({ onStateChange, onPeerChange, onError, onHostLeave }) {
    this.onStateChange = onStateChange;
    this.onPeerChange  = onPeerChange;
    this.onError       = onError;
    this.onHostLeave   = onHostLeave || null;

    this.isHost          = false;
    this.roomCode        = null;
    this.trRoom          = null;
    this.sendMsg         = null;
    this._sendEdit       = null;
    this.peerCount       = 0;
    this._heartbeat      = null;
    this._localState     = null;   // host-only: full session state

    // Observer-only tracking
    this._hostPeerId      = null;   // peer ID of the host (set on first state message)
    this._reconnectTimer  = null;   // grace period before declaring host gone
    this._helloTimer      = null;   // periodic hello until state received
    this._refreshTimer    = null;   // periodic ping to host after connected
    this._visibilityHandler = null; // re-sync on page becoming visible again
  }

  // ── Host: create a new live room ──────────────────────────────────────────
  host(sessionState, preferredCode = null) {
    const code = preferredCode || genCode();
    this.roomCode = code;
    this.isHost = true;
    this._localState = { ...sessionState };

    try {
      this.trRoom = joinRoom({ appId: APP_ID, brokerUrl: BROKER_URL }, code);
    } catch {
      this.onError?.('Live sharing unavailable — check your connection. Session continues offline.');
      return code;
    }

    const [send, onMsg] = this.trRoom.makeAction('msg');
    this.sendMsg = send;

    this.trRoom.onPeerJoin(peerId => {
      this.peerCount++;
      this.onPeerChange(this.peerCount);
      // Send full state to the newly joined observer immediately
      try { send({ type: 'state', state: this._sanitizeState(this._localState) }, peerId); } catch {}
    });

    this.trRoom.onPeerLeave(() => {
      this.peerCount = Math.max(0, this.peerCount - 1);
      this.onPeerChange(this.peerCount);
    });

    // Host accepts edit actions from participants (setup phase only)
    const [, onEdit] = this.trRoom.makeAction('edit');
    onEdit((data) => {
      if (this._localState?.phase !== 'setup') return;
      const next = this._applyEdit(data, this._localState);
      if (!next) return;
      this._localState = next;
      this._broadcastToAll();
      this.onStateChange(this._sanitizeState(this._localState));
    });

    // Re-send state whenever any observer sends a hello (handles missed initial delivery)
    onMsg((data, peerId) => {
      if (data?.type === 'hello' && this._localState) {
        try { send({ type: 'state', state: this._sanitizeState(this._localState) }, peerId); } catch {}
      }
    });

    // Heartbeat every 10s so late-joiners and reconnects get state quickly
    this._heartbeat = setInterval(() => {
      if (this._localState) this._broadcastToAll();
    }, 10000);

    // When the host's tab comes back to foreground after being backgrounded,
    // immediately re-broadcast so observers catch up without waiting for the
    // next heartbeat tick (which the browser may have delayed/skipped).
    this._visibilityHandler = () => {
      if (document.visibilityState === 'visible' && this._localState) {
        this._broadcastToAll();
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);

    return code;
  }

  // ── Host: broadcast session-ended signal then leave ───────────────────────
  end() {
    if (this.sendMsg) {
      try { this.sendMsg({ type: 'ended' }); } catch {}
    }
    this._leave();
  }

  // ── Guest: join a room as observer ────────────────────────────────────────
  join(code) {
    return new Promise((resolve, reject) => {
      this.roomCode = code;
      this.isHost = false;
      this._hostPeerId = null;

      try {
        this.trRoom = joinRoom({ appId: APP_ID, brokerUrl: BROKER_URL }, this.roomCode);
      } catch {
        reject(new Error('Could not connect to session network. Check your internet connection.'));
        return;
      }

      const [send, onMsg] = this.trRoom.makeAction('msg');
      this.sendMsg = send;

      let resolved = false;

      const joinTimeout = setTimeout(() => {
        this._clearObserverTimers();
        this._leave();
        reject(new Error(`Session "${code}" not found — check the code and try again`));
      }, 45000); // 45s — was 30s; slow WiFi needs more time

      const resolveOnce = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(joinTimeout);
        this._clearHelloTimer(); // stop pinging — we have state
      };

      // Announce to any peer already in the room
      this.trRoom.onPeerJoin(peerId => {
        try { send({ type: 'hello' }, peerId); } catch {}
      });

      // ─── Critical fix ────────────────────────────────────────────────────
      // Only react to the HOST peer leaving, not to other observers leaving.
      // Other observers leaving previously caused all remaining observers to
      // call onHostLeave() and wipe their screens — that is fixed here.
      this.trRoom.onPeerLeave((peerId) => {
        if (!this.trRoom) return;
        // Never identified the host (we have no state) — ignore all leaves
        if (!this._hostPeerId) return;
        // Some other observer left — completely ignore
        if (peerId !== this._hostPeerId) return;

        // The actual host peer disconnected.
        // Give 8s grace: WiFi flaps often reconnect in a few seconds.
        // If the host sends state within 8s, the timer is cancelled.
        if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          if (!this.trRoom) return; // already cleaned up elsewhere
          this.onHostLeave?.();
          this._leave();
        }, 8000);
      });

      onMsg((data, peerId) => {
        if (!this.trRoom) return; // guard against ghost callbacks after _leave()

        // Only 'state' and 'ended' come from the host — ignore 'hello' from other observers
        if (data.type !== 'state' && data.type !== 'ended') return;

        // Always update host identification (handles host reconnecting with new peer ID)
        this._hostPeerId = peerId;

        // Host is alive — cancel any reconnect grace timer
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = null;
        }

        resolveOnce();

        if (data.type === 'state') {
          this.onStateChange(data.state);
        } else {
          // ended
          this.onStateChange({ phase: 'ended' });
        }
      });

      // Observer edit channel: send setup-phase edits to host
      const [sendEdit] = this.trRoom.makeAction('edit');
      this._sendEdit = sendEdit;

      // Retry hello every 5s until state arrives — handles MQTT packet loss
      // on initial join where the first hello might be dropped.
      this._helloTimer = setInterval(() => {
        if (resolved) { this._clearHelloTimer(); return; }
        if (!this.sendMsg) return;
        try { this.sendMsg({ type: 'hello' }); } catch {}
      }, 5000);

      // After connected, ping host every 20s to request a fresh state.
      // This ensures state stays in sync even if a heartbeat is dropped.
      this._refreshTimer = setInterval(() => {
        if (!this.trRoom || !resolved || !this._hostPeerId || !this.sendMsg) return;
        try { this.sendMsg({ type: 'hello' }, this._hostPeerId); } catch {}
      }, 20000);

      // When the observer's tab comes back to foreground, immediately request
      // fresh state — the browser may have throttled timers while hidden.
      this._visibilityHandler = () => {
        if (document.visibilityState !== 'visible' || !this.sendMsg) return;
        try {
          if (this._hostPeerId) {
            this.sendMsg({ type: 'hello' }, this._hostPeerId);
          } else {
            this.sendMsg({ type: 'hello' }); // not yet identified host — broadcast
          }
        } catch {}
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    });
  }

  // ── Observer: send a setup-phase edit to the host ────────────────────────
  sendAction(action) {
    if (this.isHost || !this._sendEdit) return;
    try { this._sendEdit(action); } catch {}
  }

  // ── Apply an edit action to a state snapshot ──────────────────────────────
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
        const byId = Object.fromEntries(bhajans.map(e => [e.id, e]));
        const sorted = order.map(id => byId[id]).filter(Boolean);
        const missing = bhajans.filter(e => !order.includes(e.id));
        return { ...state, bhajans: [...sorted, ...missing] };
      }
      case 'update-pitch':
        return { ...state, bhajans: bhajans.map(e => e.id === action.entryId ? {
          ...e, pitch: action.pitch, pitch_indian: action.pitch_indian || null, pitch_western: action.pitch_western || null,
        } : e) };
      case 'update-notes':
        return { ...state, bhajans: bhajans.map(e => e.id === action.entryId ? { ...e, notes: action.notes } : e) };
      default:
        return null;
    }
  }

  // ── Host: update state and broadcast ─────────────────────────────────────
  updateState(newState) {
    if (!this.isHost) return;
    this._localState = { ...newState };
    this._broadcastToAll();
    this.onStateChange(this._sanitizeState(this._localState));
  }

  _broadcastToAll() {
    if (!this.sendMsg || !this._localState) return;
    try { this.sendMsg({ type: 'state', state: this._sanitizeState(this._localState) }); } catch {}
  }

  _sanitizeState(state) {
    return { ...state };
  }

  // ── Leave room ────────────────────────────────────────────────────────────
  leave() {
    this._leave();
  }

  _clearHelloTimer() {
    clearInterval(this._helloTimer);
    this._helloTimer = null;
  }

  _clearObserverTimers() {
    clearInterval(this._helloTimer);
    clearInterval(this._refreshTimer);
    clearTimeout(this._reconnectTimer);
    this._helloTimer     = null;
    this._refreshTimer   = null;
    this._reconnectTimer = null;
  }

  _leave() {
    clearInterval(this._heartbeat);
    this._heartbeat = null;
    this._clearObserverTimers();
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    try { this.trRoom?.leave?.(); } catch {}
    this.trRoom      = null;
    this.sendMsg     = null;
    this._sendEdit   = null;
    this.peerCount   = 0;
    this.isHost      = false;
    this.roomCode    = null;
    this._localState = null;
    this._hostPeerId = null;
  }

  get isConnected() { return !!this.trRoom; }
}
