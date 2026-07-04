// ─── LiveSession ─────────────────────────────────────────────────────────────
// Trystero-based real-time bhajan session sharing.
// Host-authoritative: host holds state and broadcasts to all observers.
// In setup phase, observers can send edit actions back to the host.

import { joinRoom } from 'https://esm.sh/trystero@0.21.0/mqtt';

const APP_ID     = 'bsntas-melody-miracle-v1';
const BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';

function genCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export class LiveSession {
  constructor({ onStateChange, onPeerChange, onError, onHostLeave }) {
    this.onStateChange = onStateChange; // (state) => void
    this.onPeerChange  = onPeerChange;  // (count) => void
    this.onError       = onError;       // (msg) => void
    this.onHostLeave   = onHostLeave || null; // () => void — observer only

    this.isHost    = false;
    this.roomCode  = null;
    this.trRoom    = null;
    this.sendMsg   = null;
    this._sendEdit = null; // observer → host edit channel
    this.peerCount = 0;
    this._heartbeat = null;
    this._localState = null; // host-only: full session state
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
      // Send current state to the newly joined observer
      send({ type: 'state', state: this._sanitizeState(this._localState) }, peerId);
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

    // Re-send state to any observer who missed the initial delivery
    onMsg((data, peerId) => {
      if (data?.type === 'hello' && this._localState) {
        send({ type: 'state', state: this._sanitizeState(this._localState) }, peerId);
      }
    });

    // Heartbeat: re-broadcast state every 25s so late-joiners get it
    this._heartbeat = setInterval(() => {
      if (this._localState) this._broadcastToAll();
    }, 25000);

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

      try {
        this.trRoom = joinRoom({ appId: APP_ID, brokerUrl: BROKER_URL }, this.roomCode);
      } catch {
        reject(new Error('Could not connect to session network. Check your internet connection.'));
        return;
      }

      const [send, onMsg] = this.trRoom.makeAction('msg');
      this.sendMsg = send;

      const timeout = setTimeout(() => {
        this._leave();
        reject(new Error(`Session "${code}" not found — check the code and try again`));
      }, 30000);

      let resolved = false;

      this.trRoom.onPeerJoin(peerId => {
        // Announce ourselves so the host re-sends state
        send({ type: 'hello' }, peerId);
      });

      // Host has left — notify app and clean up
      this.trRoom.onPeerLeave(() => {
        if (!this.trRoom) return; // already left
        this.onHostLeave?.();
        this._leave();
      });

      onMsg((data) => {
        if (!this.trRoom) return; // guard against ghost callbacks after _leave()
        // Any message from the host clears the join timeout
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve();
        }
        if (data.type === 'state') {
          this.onStateChange(data.state);
        } else if (data.type === 'ended') {
          this.onStateChange({ phase: 'ended' });
        }
      });

      // Observer edit channel: send setup-phase edits to host
      const [sendEdit] = this.trRoom.makeAction('edit');
      this._sendEdit = sendEdit;
    });
  }

  // ── Observer: send a setup-phase edit to the host ────────────────────────
  sendAction(action) {
    if (this.isHost || !this._sendEdit) return;
    this._sendEdit(action);
  }

  // ── Apply an edit action to a state snapshot ──────────────────────────────
  _applyEdit(action, state) {
    const bhajans = state.bhajans || [];
    switch (action.type) {
      case 'add-bhajan':
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
    this.sendMsg({ type: 'state', state: this._sanitizeState(this._localState) });
  }

  _sanitizeState(state) {
    return { ...state };
  }

  // ── Leave room ────────────────────────────────────────────────────────────
  leave() {
    this._leave();
  }

  _leave() {
    clearInterval(this._heartbeat);
    this._heartbeat = null;
    try { this.trRoom?.leave?.(); } catch {}
    this.trRoom = null;
    this.sendMsg = null;
    this._sendEdit = null;
    this.peerCount = 0;
    this.isHost = false;
    this.roomCode = null;
    this._localState = null;
  }

  get isConnected() { return !!this.trRoom; }
}
