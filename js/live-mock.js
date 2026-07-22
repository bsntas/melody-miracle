// In-memory mock of live.js for local testing — no Firebase dependency.

export class LiveSession {
  constructor({ onStateChange, onPeerChange, onConnectionChange, onError }) {
    this.onStateChange      = onStateChange;
    this.onPeerChange       = onPeerChange;
    this.onConnectionChange = onConnectionChange || null;
    this.onError            = onError;

    this.isHost    = false;
    this.roomCode  = null;
    this.peerCount = 0;
    this._state    = null;
  }

  host(sessionState, code) {
    this.isHost   = true;
    this.roomCode = code;
    this._state   = { phase: 'setup', ...sessionState };
    setTimeout(() => this.onConnectionChange?.(true), 50);
    return code;
  }

  join(code) {
    return Promise.reject(new Error('Mock: join not supported'));
  }

  updateState(newState) {
    this._state = { ...newState };
    // Simulate Firebase local echo
    setTimeout(() => this.onStateChange?.(this._state), 0);
  }

  end() { this._cleanup(); }
  leave() { this._cleanup(); }
  _cleanup() {
    this._state   = null;
    this.roomCode = null;
    this.isHost   = false;
  }

  get isConnected() { return true; }
}

export async function listOpenSessions() { return []; }
