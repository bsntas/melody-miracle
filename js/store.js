// ─── BhajanStore ─────────────────────────────────────────────────────────────
// Loads and indexes the bhajans.json catalog; provides search + filter.

const REPO_SLUG     = 'bsntas/melody-miracle';
const OVERRIDES_KEY = 'mm-bhajan-overrides';
const OVERRIDE_TTL  = 3 * 24 * 60 * 60 * 1000;

function _readOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}') || {}; } catch { return {}; }
}
function _writeOverrides(o) {
  try {
    if (Object.keys(o).length) localStorage.setItem(OVERRIDES_KEY, JSON.stringify(o));
    else localStorage.removeItem(OVERRIDES_KEY);
  } catch { /* storage full / unavailable — overlay is best-effort */ }
}
function _sameBhajan(a, b) {
  const norm = x => JSON.stringify(Object.keys(x).sort().map(k => [k, x[k] ?? null]));
  return norm(a) === norm(b);
}

export class BhajanStore {
  constructor() {
    this.bhajans = [];
    this._index = null; // fuse-style simple index
  }

  // Load the catalog from the deployed site (GitHub Pages). 'no-cache' forces a
  // conditional revalidation so the browser's HTTP cache (max-age=600 on Pages)
  // can't serve a copy that is up to 10 minutes stale. Local edits that Pages
  // hasn't caught up with yet are layered on top (see recordLocalEdit).
  async load() {
    const res = await fetch('data/bhajans.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('Failed to load bhajan catalog');
    const lm = Date.parse(res.headers.get('last-modified') || '');
    this._setCatalog(await res.json(), Number.isFinite(lm) ? lm : null);
    return this.bhajans;
  }

  _setCatalog(list, sourceTime) {
    this.bhajans = list;
    this._sourceTime = sourceTime;
    this._applyOverrides();
    this._originalCount = this.bhajans.length;
    this._buildIndex();
  }

  // ── Local edit overlay ──────────────────────────────────────────────────────
  // After an edit is committed, GitHub Pages takes a minute or more to redeploy,
  // so a reload would otherwise show the old version. Edited bhajans are kept in
  // localStorage and re-applied until the loaded catalog is newer than the edit
  // (or contains it verbatim). Entries expire after 3 days regardless.

  recordLocalEdit(bhajan) {
    const o = _readOverrides();
    o[bhajan.id] = { bhajan, at: Date.now() };
    _writeOverrides(o);
  }

  _applyOverrides() {
    const o = _readOverrides();
    const ids = Object.keys(o);
    if (!ids.length) return;
    const now = Date.now();
    let changed = false;
    for (const id of ids) {
      const { bhajan, at } = o[id] || {};
      const idx = this.bhajans.findIndex(b => b.id === id);
      const current = idx >= 0 ? this.bhajans[idx] : null;
      const caughtUp = (this._sourceTime && this._sourceTime > at)
        || (current && _sameBhajan(current, bhajan));
      if (!bhajan || caughtUp || now - at > OVERRIDE_TTL) { delete o[id]; changed = true; continue; }
      if (idx >= 0) this.bhajans[idx] = bhajan;
      else          this.bhajans.push(bhajan);
    }
    if (changed) _writeOverrides(o);
  }

  // ── Fresh copy straight from the repo ───────────────────────────────────────
  // Asks the GitHub API for the latest commit touching data/bhajans.json. If the
  // copy we loaded predates it (Pages not redeployed yet, or a stale cache), the
  // file is fetched from raw.githubusercontent.com at that exact commit SHA —
  // an immutable URL, so it is never stale. Resolves true if the catalog changed.
  async refreshFromRepo(pat = null) {
    if (this._refreshing) return false;
    this._refreshing = true;
    try {
      const headers = { Accept: 'application/vnd.github+json' };
      if (pat) headers.Authorization = `Bearer ${pat}`;
      const res = await fetch(
        `https://api.github.com/repos/${REPO_SLUG}/commits?path=data/bhajans.json&sha=main&per_page=1`,
        { headers, cache: 'no-store' },
      );
      if (!res.ok) return false;
      const [latest] = await res.json();
      const sha = latest?.sha;
      if (!sha) return false;
      const commitTime = Date.parse(latest.commit?.committer?.date || '') || null;

      if (sha === this._sha) return false;  // already showing this commit
      if (this._sha == null && commitTime && this._sourceTime && this._sourceTime >= commitTime) {
        this._sha = sha;                    // Pages copy was deployed after this commit
        return false;
      }

      const raw = await fetch(
        `https://raw.githubusercontent.com/${REPO_SLUG}/${sha}/data/bhajans.json`,
        { cache: 'no-store' },
      );
      if (!raw.ok) return false;
      const list = await raw.json();
      if (!Array.isArray(list) || !list.length) return false;
      this._sha = sha;
      this._setCatalog(list, commitTime);
      return true;
    } catch {
      return false;
    } finally {
      this._refreshing = false;
    }
  }

  _buildIndex() {
    const norm  = s => (s || '').toLowerCase();
    const words = s => norm(s).split(/[\s,/]+/).filter(w => w.length >= 2);
    this._index = this.bhajans.map(b => ({
      id:         b.id,
      titleLower: norm(b.title),
      titleWords: [...new Set(words(b.title))],
      deityWords: [...new Set(words(b.deity))],
      langWords:  [...new Set(words(b.language))],
      otherWords: [...new Set([b.raga, b.beat, b.scale].flatMap(f => words(f)))],
    }));
  }

  // Score a single query token against one bhajan index entry across all fields.
  // Returns 0 if no match; higher = more relevant.
  _tokenScore(tok, entry) {
    let best = 0;
    const check = (words, weight) => {
      for (const w of words) {
        let s = 0;
        if (w === tok)                               s = weight * 4; // exact word
        else if (w.startsWith(tok))                  s = weight * 3; // word starts with token
        else if (tok.startsWith(w) && w.length >= 2) s = weight * 2; // token starts with word
        else if (tok.length >= 3 && w.includes(tok)) s = weight;     // token is substring of word
        else if (tok.length >= 3) {
          const d = tok.length <= 5 ? 1 : 2;
          if (Math.abs(w.length - tok.length) <= d && _lev(tok, w, d) <= d)
            s = Math.ceil(weight * 0.5);                              // fuzzy (typo-tolerant)
        }
        if (s > best) best = s;
      }
    };
    check(entry.titleWords, 20);
    check(entry.deityWords,  8);
    check(entry.langWords,   6);
    check(entry.otherWords,  3);
    return best;
  }

  search(query, filters = {}) {
    const q      = (query || '').toLowerCase().trim();
    const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

    const out = [];
    this.bhajans.forEach((b, i) => {
      if (filters.deity    && !(b.deity    || '').toLowerCase().includes(filters.deity.toLowerCase()))    return;
      if (filters.language && !(b.language || '').toLowerCase().includes(filters.language.toLowerCase())) return;
      if (filters.tempo    && b.tempo !== filters.tempo) return;
      if (filters.level    && b.level !== filters.level) return;

      if (!q) { out.push({ b, score: 0 }); return; }

      const idx = this._index[i];
      let score = 0;
      let hits  = 0;
      for (const tok of tokens) {
        const ts = this._tokenScore(tok, idx);
        if (ts > 0) { score += ts; hits++; }
      }
      if (hits === 0) return;

      // Boost when all tokens matched (AND result wins over partial match)
      if (hits === tokens.length && tokens.length > 1) score += 40;
      // Boost when the full query phrase appears verbatim in the title
      if (idx.titleLower.includes(q)) score += 60;
      if (idx.titleLower.startsWith(q)) score += 30;

      out.push({ b, score });
    });

    if (!q) return out.map(r => r.b);
    out.sort((a, b) => b.score - a.score);
    return out.map(r => r.b);
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

  deleteSeries(series) {
    this._sessions = this._sessions.filter(s => s.series !== series);
    this._save();
  }

  // No-op in base class; GitHubStore overrides to commit the series to GitHub.
  addSeries(_name) {}

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
    const monthStart = _localDate(new Date(now.getFullYear(), now.getMonth(), 1));
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
      const key = _localDate(d);
      days[key] = 0;
    }
    for (const s of this._activeSessions) {
      if (days[s.date] !== undefined) days[s.date]++;
    }
    return Object.entries(days).map(([date, count]) => ({ date, count }));
  }

  activityByWeek(n = 16) {
    // Use ISO weeks (Mon–Sun) so Saturday and Sunday of the same weekend
    // always fall in the same bar.
    // Use local date components (not toISOString) to avoid UTC offset shifting
    // week boundaries by one day for users in IST and other UTC+ timezones.
    const now = new Date();
    const dow = now.getDay(); // 0=Sun … 6=Sat
    const thisMonday = new Date(now);
    thisMonday.setDate(now.getDate() + (dow === 0 ? -6 : 1 - dow));
    thisMonday.setHours(0, 0, 0, 0);

    const fmt = d => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
    const weeks = [];
    for (let i = n - 1; i >= 0; i--) {
      const monday = new Date(thisMonday);
      monday.setDate(thisMonday.getDate() - i * 7);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      const startKey = _localDate(monday);
      const endKey   = _localDate(sunday);
      const month    = monday.toLocaleDateString('en-IN', { month: 'short' });
      weeks.push({ startKey, endKey, label: fmt(monday), month, count: 0 });
    }
    for (const s of this._activeSessions) {
      const w = weeks.find(w => s.date >= w.startKey && s.date <= w.endKey);
      if (w) w.count += (s.bhajans || []).length;
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
      const endKey = _localDate(new Date(y, mo + 1, 0));
      const label = d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
      const month = d.toLocaleDateString('en-IN', { month: 'short' });
      months.push({ startKey, endKey, label, month, count: 0 });
    }
    for (const s of this._activeSessions) {
      const m = months.find(m => s.date >= m.startKey && s.date <= m.endKey);
      if (m) m.count += (s.bhajans || []).length;
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

// Local YYYY-MM-DD — avoids UTC-offset shifting dates in toISOString() for
// users in UTC+ timezones (e.g. IST) where local midnight is the previous UTC day.
function _localDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

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
  return _localDate(new Date());
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
