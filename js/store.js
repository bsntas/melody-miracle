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
    this._index = this.bhajans.map(b => {
      const text = [b.title, b.deity, b.language, b.raga, b.beat, b.scale]
        .filter(Boolean).join(' ').toLowerCase();
      return {
        id: b.id,
        searchText: text,
        words: [...new Set(text.split(/\s+/).filter(w => w.length >= 3))],
      };
    });
  }

  // Every space-separated token in q must match the entry.
  // Fast path: exact substring. Fallback: per-word fuzzy (Levenshtein).
  _matchQuery(q, entry) {
    if (entry.searchText.includes(q)) return true;
    const tokens = q.split(/\s+/).filter(Boolean);
    return tokens.every(tok => {
      if (entry.words.some(w => w.startsWith(tok) || tok.startsWith(w))) return true;
      if (tok.length < 3) return false;
      const maxDist = tok.length <= 5 ? 1 : 2;
      return entry.words.some(
        w => Math.abs(w.length - tok.length) <= maxDist && _lev(tok, w, maxDist) <= maxDist
      );
    });
  }

  search(query, filters = {}) {
    const q = (query || '').toLowerCase().trim();
    const results = this.bhajans.filter((b, i) => {
      if (q && !this._matchQuery(q, this._index[i])) return false;
      if (filters.deity && !(b.deity || '').toLowerCase().includes(filters.deity.toLowerCase())) return false;
      if (filters.language && !(b.language || '').toLowerCase().includes(filters.language.toLowerCase())) return false;
      if (filters.tempo && b.tempo !== filters.tempo) return false;
      if (filters.level && b.level !== filters.level) return false;
      return true;
    });
    if (!q) return results;
    const tokens = q.split(/\s+/).filter(Boolean);
    return results.sort((a, b) => this._scoreQuery(tokens, b) - this._scoreQuery(tokens, a));
  }

  // Score by how many times query tokens appear in the title (weight 3).
  // Higher score = more relevant. Bhajans with repeated title words rank above partial matches.
  _scoreQuery(tokens, bhajan) {
    const title = (bhajan.title || '').toLowerCase();
    let score = 0;
    for (const tok of tokens) {
      let idx = 0;
      while ((idx = title.indexOf(tok, idx)) !== -1) { score += 3; idx += tok.length; }
    }
    return score;
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
    this._seriesFilter = null;
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  // Fetch public sessions.json (served via GitHub Pages) and merge with local.
  // Used by non-PAT users so they can see history saved by the PAT user.
  // Returns true if any new sessions were merged in.
  async load(force = false) {
    try {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 5000);
      const res = await fetch('./data/sessions.json', { signal: abort.signal, ...(force ? { cache: 'no-store' } : {}) });
      clearTimeout(timer);
      if (!res.ok) return false;
      const remote = await res.json();
      if (!Array.isArray(remote) || !remote.length) return false;
      // Remote (GitHub) wins on ID conflict; keep any local-only sessions too
      const map = new Map();
      for (const s of remote) map.set(s.id, s);
      for (const s of this._sessions) if (!map.has(s.id)) map.set(s.id, s);
      this._sessions = [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
      this._save();
      return true;
    } catch {
      return false;
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

  setSeriesFilter(series) { this._seriesFilter = series || null; }

  get _activeSessions() {
    if (!this._seriesFilter) return this._sessions;
    return this._sessions.filter(s => s.series === this._seriesFilter);
  }

  // Like all() but respects the active series filter — use this for display lists.
  activeAll() {
    return [...this._activeSessions].sort((a, b) => b.date.localeCompare(a.date));
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  stats() {
    const sessions = this._activeSessions;
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
    for (const s of this._activeSessions) {
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

  bhajanSungCounts() {
    const counts = {};
    for (const s of this._activeSessions)
      for (const e of (s.bhajans || []))
        if (e.bhajan_id) counts[e.bhajan_id] = (counts[e.bhajan_id] || 0) + 1;
    return counts;
  }

  bhajanHistory(bhajanId) {
    const rows = [];
    for (const s of [...this._activeSessions].sort((a, b) => b.date.localeCompare(a.date))) {
      for (const e of (s.bhajans || [])) {
        if (e.bhajan_id === bhajanId) {
          rows.push({
            date: s.date,
            sessionLabel: s.label || '',
            singer: e.singers?.join(' · ') || e.singer || '',
            pitch_indian: e.pitch_indian || '',
            pitch_western: e.pitch_western || '',
          });
        }
      }
    }
    return rows;
  }

  topSingers(n = 10) {
    const counts = {};
    for (const s of this._activeSessions)
      for (const e of (s.bhajans || []))
        for (const name of (e.singers || (e.singer ? [e.singer] : [])))
          counts[name] = (counts[name] || 0) + 1;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([name, count]) => ({ name, count }));
  }

  deityDistribution() {
    const counts = {};
    for (const s of this._activeSessions) {
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
    for (const s of this._activeSessions) {
      if (days[s.date] !== undefined) days[s.date]++;
    }
    return Object.entries(days).map(([date, count]) => ({ date, count }));
  }

  activityByWeek(n = 16) {
    const now = new Date();
    const weeks = [];
    for (let i = n - 1; i >= 0; i--) {
      const end = new Date(now);
      end.setDate(end.getDate() - i * 7);
      const start = new Date(end);
      start.setDate(start.getDate() - 6);
      const startKey = start.toISOString().slice(0, 10);
      const endKey   = end.toISOString().slice(0, 10);
      const fmt = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      const month = start.toLocaleDateString('en-IN', { month: 'short' });
      weeks.push({ startKey, endKey, label: fmt(start), month, count: 0 });
    }
    for (const s of this._activeSessions) {
      const w = weeks.find(w => s.date >= w.startKey && s.date <= w.endKey);
      if (w) w.count++;
    }
    return weeks;
  }

  activityByMonth(n = 12) {
    const now = new Date();
    const months = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = d.getFullYear(), mo = d.getMonth();
      const startKey = `${y}-${String(mo + 1).padStart(2, '0')}-01`;
      const endKey = new Date(y, mo + 1, 0).toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
      const month = d.toLocaleDateString('en-IN', { month: 'short' });
      months.push({ startKey, endKey, label, month, count: 0 });
    }
    for (const s of this._activeSessions) {
      const m = months.find(m => s.date >= m.startKey && s.date <= m.endKey);
      if (m) m.count++;
    }
    return months;
  }

  singerHistory(name) {
    const hasSinger = e => (e.singers || (e.singer ? [e.singer] : [])).includes(name);
    const sessions = this._activeSessions
      .filter(s => (s.bhajans || []).some(hasSinger))
      .sort((a, b) => b.date.localeCompare(a.date));

    const bhajans = sessions.flatMap(s =>
      (s.bhajans || [])
        .filter(hasSinger)
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
    for (const s of this._activeSessions)
      for (const e of (s.bhajans || []))
        if ((e.singers || (e.singer ? [e.singer] : [])).includes(singerName) && e.pitch)
          counts[e.pitch] = (counts[e.pitch] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }

  // Return pitch a singer used for a specific bhajan
  singerBhajanPitch(singerName, bhajanId) {
    for (const s of [...this._activeSessions].reverse()) {
      const e = (s.bhajans || []).find(e =>
        (e.singers || (e.singer ? [e.singer] : [])).includes(singerName) && e.bhajan_id === bhajanId);
      if (e?.pitch) return e.pitch;
    }
    return null;
  }

  allSingerNames() {
    const names = new Set();
    for (const s of this._activeSessions)
      (s.bhajans || []).forEach(e =>
        (e.singers || (e.singer ? [e.singer] : [])).forEach(n => names.add(n)));
    return [...names].sort();
  }

  allSingersWithStats(fromDate = null) {
    const singers = {};
    for (const s of this._activeSessions) {
      if (fromDate && s.date < fromDate) continue;
      for (const e of (s.bhajans || []))
        for (const name of (e.singers || (e.singer ? [e.singer] : []))) {
          if (!singers[name]) singers[name] = { name, _sess: new Set(), bhajans: 0, deities: {}, pitches: {} };
          singers[name]._sess.add(s.id);
          singers[name].bhajans++;
          if (e.bhajan_deity)
            e.bhajan_deity.split(/[,/]/).map(d => d.trim()).filter(Boolean)
              .forEach(d => { singers[name].deities[d] = (singers[name].deities[d] || 0) + 1; });
          if (e.pitch) singers[name].pitches[e.pitch] = (singers[name].pitches[e.pitch] || 0) + 1;
        }
    }
    return Object.values(singers).map(s => ({
      name: s.name, sessionCount: s._sess.size, bhajanCount: s.bhajans,
      topDeity: Object.entries(s.deities).sort((a,b) => b[1]-a[1])[0]?.[0] || null,
      deities: s.deities,
      pitches: s.pitches,
      usualPitch: Object.entries(s.pitches).sort((a,b) => b[1]-a[1])[0]?.[0] || null,
    })).sort((a, b) => b.bhajanCount - a.bhajanCount);
  }

  singerDeityStats(name) {
    const counts = {};
    for (const s of this._activeSessions)
      for (const e of (s.bhajans || []))
        if ((e.singers || (e.singer ? [e.singer] : [])).includes(name) && e.bhajan_deity)
          e.bhajan_deity.split(/[,/]/).map(d => d.trim()).filter(Boolean)
            .forEach(d => { counts[d] = (counts[d] || 0) + 1; });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([deity, count]) => ({ deity, count, pct: total ? Math.round(count / total * 100) : 0 }));
  }

  coSingers(name) {
    const counts = {};
    for (const s of this._activeSessions)
      for (const e of (s.bhajans || [])) {
        const names = e.singers || (e.singer ? [e.singer] : []);
        if (names.includes(name)) names.forEach(n => { if (n !== name) counts[n] = (counts[n] || 0) + 1; });
      }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([name, count]) => ({ name, count }));
  }

  topBhajansFrom(n = 5, fromDate = null) {
    const counts = {};
    for (const s of this._activeSessions) {
      if (fromDate && s.date < fromDate) continue;
      for (const e of (s.bhajans || [])) {
        if (!e.bhajan_id) continue;
        if (!counts[e.bhajan_id]) counts[e.bhajan_id] = { id: e.bhajan_id, title: e.bhajan_title, count: 0 };
        counts[e.bhajan_id].count++;
      }
    }
    return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, n);
  }

  topSingersFrom(n = 5, fromDate = null) {
    const counts = {};
    for (const s of this._activeSessions) {
      if (fromDate && s.date < fromDate) continue;
      for (const e of (s.bhajans || []))
        (e.singers || (e.singer ? [e.singer] : [])).forEach(name => { counts[name] = (counts[name] || 0) + 1; });
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([name, count]) => ({ name, count }));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Levenshtein distance with early exit when cost exceeds max.
function _lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = row[j];
      row[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > max) return max + 1;
  }
  return row[b.length];
}

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
