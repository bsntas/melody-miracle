// ─── BhajanStore ─────────────────────────────────────────────────────────────
// Loads and indexes the bhajans.json catalog; provides search + filter.

export class BhajanStore {
  constructor() {
    this.bhajans = [];
    this._index = null; // fuse-style simple index
  }

  async load() {
    const res = await fetch('data/bhajans.json');
    if (!res.ok) throw new Error('Failed to load bhajan catalog');
    this.bhajans = await res.json();
    this._buildIndex();
    return this.bhajans;
  }

  _buildIndex() {
    this._index = this.bhajans.map(b => ({
      id: b.id,
      searchText: [b.title, b.deity, b.language, b.raga, b.beat].filter(Boolean).join(' ').toLowerCase(),
    }));
  }

  search(query, filters = {}) {
    const q = (query || '').toLowerCase().trim();
    return this.bhajans.filter((b, i) => {
      if (q && !this._index[i].searchText.includes(q)) return false;
      if (filters.deity && !(b.deity || '').toLowerCase().includes(filters.deity.toLowerCase())) return false;
      if (filters.language && !(b.language || '').toLowerCase().includes(filters.language.toLowerCase())) return false;
      if (filters.tempo && b.tempo !== filters.tempo) return false;
      if (filters.level && b.level !== filters.level) return false;
      return true;
    });
  }

  getById(id) {
    return this.bhajans.find(b => b.id === id) || null;
  }

  uniqueValues(field) {
    const vals = new Set();
    for (const b of this.bhajans) {
      if (b[field]) {
        // Some fields have multi-value (e.g., "Guru, Sai") — split on comma
        const parts = b[field].split(/[,/]/).map(p => p.trim()).filter(Boolean);
        for (const p of parts) vals.add(p);
      }
    }
    return [...vals].sort();
  }

  uniqueExact(field) {
    const vals = new Set();
    for (const b of this.bhajans) {
      if (b[field]) vals.add(b[field]);
    }
    return [...vals].sort();
  }
}

// ─── SessionStore ─────────────────────────────────────────────────────────────
// CRUD for bhajan sessions in localStorage.

const STORAGE_KEY = 'bm-sessions-v2';
const DRAFT_KEY   = 'bm-draft-session';

export class SessionStore {
  constructor() {
    this._sessions = this._load();
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._sessions));
    } catch (e) {
      console.warn('SessionStore: localStorage save failed', e);
    }
  }

  all() { return [...this._sessions].sort((a, b) => b.date.localeCompare(a.date)); }

  get(id) { return this._sessions.find(s => s.id === id) || null; }

  save(session) {
    const idx = this._sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) {
      this._sessions[idx] = { ...session };
    } else {
      this._sessions.push({ ...session });
    }
    this._save();
  }

  delete(id) {
    this._sessions = this._sessions.filter(s => s.id !== id);
    this._save();
  }

  // Draft: in-progress session so host can recover on refresh
  saveDraft(session) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(session)); } catch {}
  }

  getDraft() {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
  }

  knownSeries() {
    const s = new Set();
    for (const sess of this._sessions) if (sess.series) s.add(sess.series);
    return [...s].sort();
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  stats() {
    const sessions = this._sessions;
    const total = sessions.length;

    const allBhajans = sessions.flatMap(s => s.bhajans || []);
    const totalBhajans = allBhajans.length;

    const singers = new Set(sessions.flatMap(s => s.singers || []));

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const thisMonth = sessions.filter(s => s.date >= monthStart).length;

    return { total, totalBhajans, singers: singers.size, thisMonth };
  }

  topBhajans(n = 10) {
    const counts = {};
    const titles = {};
    for (const s of this._sessions) {
      for (const e of (s.bhajans || [])) {
        counts[e.bhajan_id] = (counts[e.bhajan_id] || 0) + 1;
        titles[e.bhajan_id] = e.bhajan_title;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([id, count]) => ({ id, title: titles[id], count }));
  }

  topSingers(n = 10) {
    const counts = {};
    for (const s of this._sessions) {
      for (const e of (s.bhajans || [])) {
        if (e.singer) counts[e.singer] = (counts[e.singer] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, count]) => ({ name, count }));
  }

  deityDistribution() {
    const counts = {};
    for (const s of this._sessions) {
      for (const e of (s.bhajans || [])) {
        const deity = e.bhajan_deity;
        if (deity) {
          deity.split(/[,/]/).map(d => d.trim()).filter(Boolean).forEach(d => {
            counts[d] = (counts[d] || 0) + 1;
          });
        }
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }));
  }

  activityLast30Days() {
    const days = {};
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      days[key] = 0;
    }
    for (const s of this._sessions) {
      if (days[s.date] !== undefined) days[s.date]++;
    }
    return Object.entries(days).map(([date, count]) => ({ date, count }));
  }

  singerHistory(name) {
    const sessions = this._sessions
      .filter(s => (s.singers || []).includes(name) || (s.bhajans || []).some(e => e.singer === name))
      .sort((a, b) => b.date.localeCompare(a.date));

    const bhajans = sessions.flatMap(s =>
      (s.bhajans || [])
        .filter(e => e.singer === name)
        .map(e => ({ ...e, sessionDate: s.date, sessionLabel: s.label }))
    );

    const pitchCounts = {};
    for (const e of bhajans) {
      if (e.pitch) pitchCounts[e.pitch] = (pitchCounts[e.pitch] || 0) + 1;
    }
    const usualPitch = Object.entries(pitchCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

    const bhajansById = {};
    for (const e of bhajans) {
      if (!bhajansById[e.bhajan_id]) {
        bhajansById[e.bhajan_id] = { id: e.bhajan_id, title: e.bhajan_title, count: 0, lastPitch: e.pitch };
      }
      bhajansById[e.bhajan_id].count++;
    }
    const uniqueBhajans = Object.values(bhajansById).sort((a, b) => b.count - a.count);

    return { sessions, bhajans, usualPitch, uniqueBhajans };
  }

  // Return the pitch a given singer most commonly uses (from all history)
  singerUsualPitch(singerName) {
    const counts = {};
    for (const s of this._sessions) {
      for (const e of (s.bhajans || [])) {
        if (e.singer === singerName && e.pitch) {
          counts[e.pitch] = (counts[e.pitch] || 0) + 1;
        }
      }
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  // Return pitch a singer used for a specific bhajan
  singerBhajanPitch(singerName, bhajanId) {
    for (const s of [...this._sessions].reverse()) {
      const e = (s.bhajans || []).find(e => e.singer === singerName && e.bhajan_id === bhajanId);
      if (e?.pitch) return e.pitch;
    }
    return null;
  }

  allSingerNames() {
    const names = new Set();
    for (const s of this._sessions) {
      (s.singers || []).forEach(n => names.add(n));
      (s.bhajans || []).forEach(e => { if (e.singer) names.add(e.singer); });
    }
    return [...names].sort();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function genId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function monthLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

export function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
