// ─── GitHubStore ─────────────────────────────────────────────────────────────
// Stores bhajan sessions as data/sessions.json committed directly to the
// melody-miracle repo on the main branch via the GitHub Contents API.
//
// Design:
//   - localStorage is the immediate write-through cache (fast, offline)
//   - GitHub is the authoritative cross-device store
//   - Commits are debounced + serialised to avoid SHA conflicts
//   - On 409 conflict: fetch latest → merge by session ID → retry once

const OWNER         = 'bsntas';
const REPO          = 'melody-miracle';
const BRANCH        = 'main';
const SESSIONS_PATH = 'data/sessions.json';
const API_BASE      = 'https://api.github.com';
const CACHE_KEY     = 'bm-sessions-v2';          // same key as SessionStore
const PAT_KEY       = 'bm-github-pat';
const SYNC_META_KEY = 'bm-sync-meta';

export class GitHubStore {
  constructor(pat) {
    this._pat         = pat;
    this._sessions    = this._loadCache();
    this._sha         = null;   // current file SHA on GitHub
    this._busy        = false;  // commit in-flight?
    this._dirty       = false;  // changed while commit was in-flight?
    this.syncStatus   = 'idle'; // 'idle' | 'syncing' | 'ok' | 'error'
    this.onSyncChange = null;   // (status, message?) => void
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  async load() {
    this._setSync('syncing');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 12000);
    try {
      const { sessions, sha } = await this._fetchFromGitHub(abort.signal);
      clearTimeout(timer);
      this._sha = sha;

      // Merge GitHub sessions with any local-only sessions
      const merged = this._mergeSessions(sessions, this._sessions);
      this._sessions = merged;
      this._saveCache();

      this._setSync('ok', `Synced ${new Date().toLocaleTimeString()}`);

      // If local had extra sessions that GitHub didn't, push them up
      if (merged.length > sessions.length) {
        this._scheduleCommit('Sync local sessions to GitHub');
      }

      return merged;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        this._setSync('error', 'Sync timed out — using local data');
        return this._sessions;
      }
      if (err.status === 404) {
        // sessions.json doesn't exist yet — start empty (or use local cache)
        this._sha = null;
        this._setSync('ok', 'No remote sessions yet');
        return this._sessions;
      }
      this._setSync('error', err.message || 'Sync failed');
      // Fall back to local cache
      return this._sessions;
    }
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  all()  { return [...this._sessions].sort((a, b) => b.date.localeCompare(a.date)); }
  get(id) { return this._sessions.find(s => s.id === id) || null; }

  save(session) {
    const idx = this._sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) this._sessions[idx] = { ...session };
    else          this._sessions.push({ ...session });
    this._saveCache();
    this._scheduleCommit();
  }

  delete(id) {
    this._sessions = this._sessions.filter(s => s.id !== id);
    this._saveCache();
    this._scheduleCommit();
  }

  // Draft (session in progress) — local only, no commit needed
  saveDraft(s)  { try { localStorage.setItem('bm-draft-session', JSON.stringify(s)); } catch {} }
  getDraft()    { try { return JSON.parse(localStorage.getItem('bm-draft-session')); } catch { return null; } }
  clearDraft()  { try { localStorage.removeItem('bm-draft-session'); } catch {} }

  // ── Analytics (identical to SessionStore) ────────────────────────────────────

  stats() {
    const sessions      = this._sessions;
    const total         = sessions.length;
    const allBhajans    = sessions.flatMap(s => s.bhajans || []);
    const totalBhajans  = allBhajans.length;
    const singers       = new Set(sessions.flatMap(s => s.singers || []));
    const now           = new Date();
    const monthStart    = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const thisMonth     = sessions.filter(s => s.date >= monthStart).length;
    return { total, totalBhajans, singers: singers.size, thisMonth };
  }

  topBhajans(n = 10) {
    const counts = {}; const titles = {};
    for (const s of this._sessions)
      for (const e of (s.bhajans || [])) {
        counts[e.bhajan_id] = (counts[e.bhajan_id] || 0) + 1;
        titles[e.bhajan_id] = e.bhajan_title;
      }
    return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,n)
      .map(([id,count])=>({ id, title: titles[id], count }));
  }

  bhajanSungCounts() {
    const counts = {};
    for (const s of this._sessions)
      for (const e of (s.bhajans || []))
        if (e.bhajan_id) counts[e.bhajan_id] = (counts[e.bhajan_id] || 0) + 1;
    return counts;
  }

  bhajanHistory(bhajanId) {
    const rows = [];
    for (const s of [...this._sessions].sort((a,b) => b.date.localeCompare(a.date))) {
      for (const e of (s.bhajans || [])) {
        if (e.bhajan_id === bhajanId) {
          rows.push({
            date: s.date,
            sessionLabel: s.label || '',
            singer: e.singer || '',
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
    for (const s of this._sessions)
      for (const e of (s.bhajans || []))
        if (e.singer) counts[e.singer] = (counts[e.singer] || 0) + 1;
    return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,n)
      .map(([name,count])=>({ name, count }));
  }

  deityDistribution() {
    const counts = {};
    for (const s of this._sessions)
      for (const e of (s.bhajans || []))
        if (e.bhajan_deity)
          e.bhajan_deity.split(/[,/]/).map(d=>d.trim()).filter(Boolean)
            .forEach(d => { counts[d] = (counts[d]||0)+1; });
    return Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,8)
      .map(([name,count])=>({ name, count }));
  }

  activityLast30Days() {
    const days = {};
    const now = new Date();
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate()-i);
      days[d.toISOString().slice(0,10)] = 0;
    }
    for (const s of this._sessions)
      if (days[s.date] !== undefined) days[s.date]++;
    return Object.entries(days).map(([date,count])=>({ date, count }));
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
    for (const s of this._sessions) {
      const w = weeks.find(w => s.date >= w.startKey && s.date <= w.endKey);
      if (w) w.count++;
    }
    return weeks;
  }

  singerHistory(name) {
    const sessions = this._sessions
      .filter(s => (s.singers||[]).includes(name) || (s.bhajans||[]).some(e=>e.singer===name))
      .sort((a,b)=>b.date.localeCompare(a.date));
    const bhajans = sessions.flatMap(s =>
      (s.bhajans||[]).filter(e=>e.singer===name)
        .map(e=>({ ...e, sessionDate: s.date, sessionLabel: s.label })));
    const pitchCounts = {};
    for (const e of bhajans) if (e.pitch) pitchCounts[e.pitch]=(pitchCounts[e.pitch]||0)+1;
    const usualPitch = Object.entries(pitchCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
    const bhajansById = {};
    for (const e of bhajans) {
      if (!bhajansById[e.bhajan_id])
        bhajansById[e.bhajan_id]={ id:e.bhajan_id, title:e.bhajan_title, count:0, lastPitch:e.pitch };
      bhajansById[e.bhajan_id].count++;
    }
    return { sessions, bhajans, usualPitch, uniqueBhajans: Object.values(bhajansById).sort((a,b)=>b.count-a.count) };
  }

  singerUsualPitch(name) {
    const counts = {};
    for (const s of this._sessions)
      for (const e of (s.bhajans||[]))
        if (e.singer===name && e.pitch) counts[e.pitch]=(counts[e.pitch]||0)+1;
    return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0]?.[0]||null;
  }

  singerBhajanPitch(name, bhajanId) {
    for (const s of [...this._sessions].reverse()) {
      const e = (s.bhajans||[]).find(e=>e.singer===name && e.bhajan_id===bhajanId);
      if (e?.pitch) return e.pitch;
    }
    return null;
  }

  allSingerNames() {
    const names = new Set();
    for (const s of this._sessions) {
      (s.singers||[]).forEach(n=>names.add(n));
      (s.bhajans||[]).forEach(e=>{ if(e.singer) names.add(e.singer); });
    }
    return [...names].sort();
  }

  knownSeries() {
    const s = new Set();
    for (const sess of this._sessions) if (sess.series) s.add(sess.series);
    return [...s].sort();
  }

  // ── GitHub API ────────────────────────────────────────────────────────────────

  async _fetchFromGitHub(signal) {
    const res = await this._api('GET', `/repos/${OWNER}/${REPO}/contents/${SESSIONS_PATH}?ref=${BRANCH}`, null, signal);
    if (res.status === 404) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const data = await res.json();
    const content = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g,'')))));
    return { sessions: content, sha: data.sha };
  }

  async _commitToGitHub(message = 'Update bhajan sessions') {
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(this._sessions, null, 2))));
    const body = { message: `${message} [${new Date().toISOString().slice(0,10)}]`, content, branch: BRANCH };
    if (this._sha) body.sha = this._sha;

    const res = await this._api('PUT', `/repos/${OWNER}/${REPO}/contents/${SESSIONS_PATH}`, body);

    if (res.status === 409) {
      // Conflict: another device committed first. Fetch latest, merge, retry.
      const { sessions: remote, sha } = await this._fetchFromGitHub();
      this._sha = sha;
      this._sessions = this._mergeSessions(remote, this._sessions);
      this._saveCache();
      return this._commitToGitHub('Merge and update bhajan sessions');
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub write error: ${res.status}`);
    }

    const data = await res.json();
    this._sha = data.content?.sha;
    // Record last sync time
    try { localStorage.setItem(SYNC_META_KEY, JSON.stringify({ ts: Date.now() })); } catch {}
  }

  // Serialised commit queue: don't overlap commits (avoids SHA race)
  _scheduleCommit(msg) {
    if (this._busy) { this._dirty = true; return; }
    this._busy = true;
    this._setSync('syncing');
    this._commitToGitHub(msg)
      .then(() => {
        this._setSync('ok', `Saved ${new Date().toLocaleTimeString()}`);
        if (this._dirty) {
          this._dirty = false;
          this._busy = false;
          this._scheduleCommit();
        } else {
          this._busy = false;
        }
      })
      .catch(err => {
        this._busy = false;
        this._dirty = false;
        this._setSync('error', err.message || 'Sync failed');
      });
  }

  _api(method, path, body, signal) {
    return fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: {
        'Authorization': `Bearer ${this._pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  // Merge two session arrays by ID — remote wins on conflict
  _mergeSessions(remote, local) {
    const map = new Map();
    for (const s of remote) map.set(s.id, s);
    for (const s of local)  if (!map.has(s.id)) map.set(s.id, s);
    return [...map.values()].sort((a,b) => b.date.localeCompare(a.date));
  }

  // ── Cache ─────────────────────────────────────────────────────────────────────

  _loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || []; } catch { return []; }
  }

  _saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(this._sessions)); } catch {}
  }

  _setSync(status, message) {
    this.syncStatus = status;
    this.onSyncChange?.(status, message);
  }

  // ── PAT helpers (static) ──────────────────────────────────────────────────────

  static getPat() {
    try { return localStorage.getItem(PAT_KEY) || ''; } catch { return ''; }
  }

  static setPat(pat) {
    try { localStorage.setItem(PAT_KEY, pat); } catch {}
  }

  static clearPat() {
    try { localStorage.removeItem(PAT_KEY); } catch {}
  }

  static lastSynced() {
    try {
      const m = JSON.parse(localStorage.getItem(SYNC_META_KEY));
      return m?.ts ? new Date(m.ts) : null;
    } catch { return null; }
  }

  // Test a PAT by fetching repo info
  static async testPat(pat) {
    const res = await fetch(`${API_BASE}/repos/${OWNER}/${REPO}`, {
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }
    });
    if (res.status === 401) throw new Error('Invalid token — check it and try again');
    if (res.status === 404) throw new Error('Repo not found or token lacks repo access');
    if (!res.ok) throw new Error(`GitHub error: ${res.status}`);
    const data = await res.json();
    if (!data.permissions?.push) throw new Error('Token needs write permission to this repo');
    return true;
  }
}
