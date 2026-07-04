import { BhajanStore, SessionStore, genId, formatDate, formatTime, todayISO, monthLabel, escHtml } from './store.js?v=20260704.7';
import { GitHubStore } from './github-store.js?v=20260704.7';
import { LiveSession } from './live.js?v=20260704.7';

const _localDate = d => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// ─── Pitch lookup ──────────────────────────────────────────────────────────────

const PITCH_OPTIONS = [
  { combined:'1 Pancham / C',    indian:'1 Pancham',   western:'C',  series:'Pancham' },
  { combined:'1.5 Pancham / C#', indian:'1.5 Pancham', western:'C#', series:'Pancham' },
  { combined:'2 Pancham / D',    indian:'2 Pancham',   western:'D',  series:'Pancham' },
  { combined:'2.5 Pancham / E',  indian:'2.5 Pancham', western:'E',  series:'Pancham' },
  { combined:'3 Pancham / E',    indian:'3 Pancham',   western:'E',  series:'Pancham' },
  { combined:'4 Pancham / F',    indian:'4 Pancham',   western:'F',  series:'Pancham' },
  { combined:'4.5 Pancham / F#', indian:'4.5 Pancham', western:'F#', series:'Pancham' },
  { combined:'5 Pancham / G',    indian:'5 Pancham',   western:'G',  series:'Pancham' },
  { combined:'5.5 Pancham / G#', indian:'5.5 Pancham', western:'G#', series:'Pancham' },
  { combined:'6 Pancham / A',    indian:'6 Pancham',   western:'A',  series:'Pancham' },
  { combined:'6.5 Pancham / A#', indian:'6.5 Pancham', western:'A#', series:'Pancham' },
  { combined:'7 Pancham / B',    indian:'7 Pancham',   western:'B',  series:'Pancham' },
  { combined:'1 Madhyam / F',    indian:'1 Madhyam',   western:'F',  series:'Madhyam' },
  { combined:'1.5 Madhyam / F#', indian:'1.5 Madhyam', western:'F#', series:'Madhyam' },
  { combined:'2 Madhyam / G',    indian:'2 Madhyam',   western:'G',  series:'Madhyam' },
  { combined:'2.5 Madhyam / G#', indian:'2.5 Madhyam', western:'G#', series:'Madhyam' },
  { combined:'3 Madhyam / A',    indian:'3 Madhyam',   western:'A',  series:'Madhyam' },
  { combined:'4 Madhyam / A#',   indian:'4 Madhyam',   western:'A#', series:'Madhyam' },
  { combined:'4.5 Madhyam / B',  indian:'4.5 Madhyam', western:'B',  series:'Madhyam' },
  { combined:'5 Madhyam / C',    indian:'5 Madhyam',   western:'C',  series:'Madhyam' },
  { combined:'5.5 Madhyam / C#', indian:'5.5 Madhyam', western:'C#', series:'Madhyam' },
  { combined:'6 Madhyam / D',    indian:'6 Madhyam',   western:'D',  series:'Madhyam' },
  { combined:'6.5 Madhyam / E',  indian:'6.5 Madhyam', western:'E',  series:'Madhyam' },
  { combined:'7 Madhyam / E',    indian:'7 Madhyam',   western:'E',  series:'Madhyam' },
];

function pitchByIndian(indian)   { return PITCH_OPTIONS.find(p => p.indian   === indian)   || null; }
function pitchByCombined(combined) { return PITCH_OPTIONS.find(p => p.combined === combined) || null; }

// When choosing by Western note: prefer given series, take last match in that series
function pitchByWestern(western, preferredSeries = 'Pancham') {
  const matches = PITCH_OPTIONS.filter(p => p.western === western);
  if (!matches.length) return null;
  const inSeries = matches.filter(p => p.series === preferredSeries);
  const pool = inSeries.length ? inSeries : matches;
  return pool[pool.length - 1];
}

// Split a combined pitch string into { pitch_indian, pitch_western }
function splitPitchCombined(combined) {
  if (!combined) return { pitch_indian: null, pitch_western: null };
  const p = pitchByCombined(combined);
  if (p) return { pitch_indian: p.indian, pitch_western: p.western };
  const parts = combined.split(' / ');
  return { pitch_indian: parts[0]?.trim() || null, pitch_western: parts[1]?.trim() || null };
}

// ─── App ──────────────────────────────────────────────────────────────────────

class App {
  constructor() {
    this.bhajans   = new BhajanStore();
    this.sessions  = new SessionStore();  // replaced by GitHubStore if PAT set
    this.live      = null;  // LiveSession instance when active
    this.liveState = null;  // current live session state (host or observer)

    this._toastTimer      = null;
    this._browseSearchTimer = null;
    this._browseFiltered  = [];
    this._browsePage      = 0;
    this._mabSelected  = null; // bhajan selected in Add Bhajan modal
    this._mabStep      = 1;
    this._mabSingers   = [];   // currently-selected singers for the entry being added
    this._mabSuggestions = []; // full suggestion list for quick-select chips
    this._bhajanModalContext = null;

    // Dashboard period filter
    this._dashPeriod = 'all';

    // Series filter (null = all series)
    try {
      this._selectedSeries = localStorage.getItem('mm-series-filter') || null;
    } catch { this._selectedSeries = null; }

    // Locally-created series names (persisted until browser data cleared)
    try {
      this._localSeries = JSON.parse(localStorage.getItem('mm-local-series') || '[]');
    } catch { this._localSeries = []; }

    // Singer aliases: { aliasName -> canonicalName }
    try {
      this._singerAliases = JSON.parse(localStorage.getItem('mm-singer-aliases') || '{}');
    } catch { this._singerAliases = {}; }

    this._init();
  }

  async _init() {
    let bhajansOk = true;
    let pat;
    try {
      try {
        await this.bhajans.load();
      } catch (e) {
        bhajansOk = false;
      }

      // Upgrade to GitHub-backed store if a PAT is saved
      pat = GitHubStore.getPat();
      if (pat) {
        const ghStore = new GitHubStore(pat);
        ghStore.onSyncChange = (status, msg) => this._onSyncChange(status, msg);
        this.sessions = ghStore;
        document.getElementById('loading-text').textContent = 'Syncing sessions…';
        try { await this.sessions.load(); } catch (e) { console.warn('GitHub sync failed on startup:', e); }
      } else {
        // No PAT: load public sessions.json in the background — never block app startup
        this.sessions.load().then(changed => {
          if (changed) { this._initSeriesFilter(); this._route(); }
        });
      }

      this._migratePitchFields();
      this._migrateSingersFields();
      this._populateFilters();
      this._bindGlobal();
      this._bindSettings();
      this._initKeyboardAdjust();
    } catch (e) {
      console.error('App init error:', e);
    } finally {
      this._hideLoading();
    }
    this._updateSyncIndicator(pat ? this.sessions.syncStatus : 'local');
    if (!bhajansOk) this._toast('Bhajan catalog failed to load — browse & search unavailable', 'error');
    this._initSeriesFilter();
    this._route();
    window.addEventListener('hashchange', () => this._route());
  }

  // Backfill pitch_indian / pitch_western on any session entries that pre-date this feature
  _migratePitchFields() {
    for (const s of this.sessions.all()) {
      const bhajans = s.bhajans || [];
      if (!bhajans.some(e => e.pitch && !e.pitch_indian)) continue;
      this.sessions.save({
        ...s,
        bhajans: bhajans.map(e => {
          if (e.pitch && !e.pitch_indian) {
            const { pitch_indian, pitch_western } = splitPitchCombined(e.pitch);
            return { ...e, pitch_indian, pitch_western };
          }
          return e;
        }),
      });
    }
  }

  // Migrate from e.singer (single string) to e.singers (array of strings)
  _migrateSingersFields() {
    for (const s of this.sessions.all()) {
      const bhajans = s.bhajans || [];
      if (!bhajans.some(e => ('singer' in e))) continue;
      this.sessions.save({
        ...s,
        bhajans: bhajans.map(e => {
          if ('singer' in e) {
            const singers = e.singers || (e.singer ? [e.singer] : []);
            const newEntry = { ...e, singers };
            delete newEntry.singer;
            return newEntry;
          }
          return e;
        }),
      });
    }
  }

  _hideLoading() {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');
  }

  // ─── Singer alias helpers ─────────────────────────────────────────────────

  _canonName(name) {
    return this._singerAliases[name] || name;
  }

  _allAliasesOf(canonName) {
    const result = [canonName];
    for (const [alias, canon] of Object.entries(this._singerAliases)) {
      if (canon === canonName && !result.includes(alias)) result.push(alias);
    }
    return result;
  }

  _singerHistoryMerged(canonName) {
    const names = this._allAliasesOf(canonName);
    if (names.length === 1) return this.sessions.singerHistory(canonName);
    const allSessionsMap = new Map();
    const allBhajans = [];
    for (const n of names) {
      const { sessions, bhajans } = this.sessions.singerHistory(n);
      for (const s of sessions) allSessionsMap.set(s.id, s);
      allBhajans.push(...bhajans);
    }
    const sessions = [...allSessionsMap.values()].sort((a, b) => b.date.localeCompare(a.date));
    const pitchCounts = {};
    for (const e of allBhajans) {
      if (e.pitch) pitchCounts[e.pitch] = (pitchCounts[e.pitch] || 0) + 1;
    }
    const usualPitch = Object.entries(pitchCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const bhajansById = {};
    for (const e of allBhajans) {
      if (!bhajansById[e.bhajan_id]) {
        bhajansById[e.bhajan_id] = { id: e.bhajan_id, title: e.bhajan_title, count: 0, lastPitch: e.pitch };
      }
      bhajansById[e.bhajan_id].count++;
    }
    const uniqueBhajans = Object.values(bhajansById).sort((a, b) => b.count - a.count);
    return { sessions, bhajans: allBhajans, usualPitch, uniqueBhajans };
  }

  _saveAliases() {
    localStorage.setItem('mm-singer-aliases', JSON.stringify(this._singerAliases));
  }

  _addAlias(fromName, toName) {
    if (!fromName || !toName || fromName === toName) return false;
    // Prevent cycles: if toName is already an alias of fromName
    if (this._canonName(toName) === fromName) return false;
    this._singerAliases[fromName] = toName;
    this._saveAliases();
    return true;
  }

  _removeAlias(fromName) {
    delete this._singerAliases[fromName];
    this._saveAliases();
  }

  // Return singer names with aliases applied (canonical names only, merged counts)
  _canonSingers(rawList) {
    const merged = {};
    for (const { name, count } of rawList) {
      const canon = this._canonName(name);
      merged[canon] = (merged[canon] || 0) + count;
    }
    return Object.entries(merged)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  _route() {
    const hash = location.hash.slice(1) || 'dashboard';
    const [view, param] = hash.split('/');

    const views = ['dashboard', 'browse', 'session', 'history', 'singers', 'sung', 'singer', 'session-detail'];
    views.forEach(v => document.getElementById(`view-${v}`)?.classList.remove('active'));

    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    document.querySelectorAll('[data-view]').forEach(el => {
      el.classList.toggle('active', el.dataset.view === view);
    });

    this._renderSeriesStrip();

    switch (view) {
      case 'dashboard':     this._renderDashboard(); break;
      case 'browse':        this._renderBrowse(); break;
      case 'session':       this._renderSession(); break;
      case 'history':       this._renderHistory(); break;
      case 'singers':       this._renderSingers(); break;
      case 'sung':          this._renderSung(); break;
      case 'singer':        if (param) this._renderSinger(decodeURIComponent(param)); break;
      case 'session-detail': if (param) this._renderSessionDetail(param); break;
    }
  }

  // ─── Toast ────────────────────────────────────────────────────────────────

  _toast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast show ${type ? 'toast-' + type : ''}`;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  // ─── Series Filter ────────────────────────────────────────────────────────

  _initSeriesFilter() {
    const allSeries = this.sessions.knownSeries();
    const draft = this.sessions.getDraft?.();

    // If a series is already selected (restored from localStorage), keep it —
    // it may belong to a live draft session not yet in knownSeries().
    // Only auto-select if there is genuinely no preference saved.
    if (!this._selectedSeries) {
      // Prefer the draft's series so the strip matches what's in progress.
      if (draft?.series) {
        this._selectedSeries = draft.series;
      } else if (allSeries.length > 0) {
        const recent = this.sessions.all();
        this._selectedSeries = recent[0]?.series || allSeries[0] || null;
      }
    }

    this.sessions.setSeriesFilter(this._selectedSeries);
    this._renderSeriesStrip();
  }

  _setSeriesFilter(series) {
    this._selectedSeries = series || null;
    try { localStorage.setItem('mm-series-filter', this._selectedSeries || ''); } catch {}
    this.sessions.setSeriesFilter(this._selectedSeries);
    this._renderSeriesStrip();
    this._route();
  }

  _renderSeriesStrip() {
    const strip = document.getElementById('series-strip');
    if (!strip) return;
    const sel = this._selectedSeries;
    let allSeries = this.sessions.knownSeries();
    // Merge locally-created series (persisted in localStorage, survive until
    // browser data is cleared — independent of which series is currently active).
    for (const s of this._localSeries) {
      if (!allSeries.includes(s)) allSeries.push(s);
    }
    // Also include the draft's series (live session in progress).
    const draftSeries = this.sessions.getDraft?.()?.series;
    if (draftSeries && !allSeries.includes(draftSeries)) allSeries.push(draftSeries);
    // Also include the currently selected series (catches edge cases).
    if (sel && !allSeries.includes(sel)) allSeries.push(sel);
    allSeries = allSeries.sort();
    strip.classList.remove('hidden');
    const pillsEl = document.getElementById('series-pills');

    const seriesPillHtml = (s) => {
      const active = s === sel;
      const lp = `data-longpress="${escHtml(s)}" title="Hold to delete"`;
      if (active) {
        return `<span class="series-pill series-pill-active" ${lp}>${escHtml(s)}</span>`;
      }
      return `<button class="series-pill" data-series="${escHtml(s)}" ${lp}>${escHtml(s)}</button>`;
    };

    if (allSeries.length === 0) {
      pillsEl.innerHTML = `<button class="series-pill series-pill-new" id="btn-series-new">+ New Series</button>`;
    } else if (allSeries.length === 1) {
      const s = allSeries[0];
      pillsEl.innerHTML =
        `<span class="series-pill series-pill-active" data-longpress="${escHtml(s)}" title="Hold to delete">${escHtml(s)}</span>` +
        `<button class="series-pill series-pill-new" id="btn-series-new">+ New</button>`;
    } else {
      pillsEl.innerHTML =
        `<button class="series-pill${!sel ? ' series-pill-active' : ''}" data-series="">All</button>` +
        allSeries.map(s => seriesPillHtml(s)).join('') +
        `<button class="series-pill series-pill-new" id="btn-series-new">+ New</button>`;
      pillsEl.querySelectorAll('.series-pill[data-series]').forEach(btn => {
        btn.addEventListener('click', () => this._setSeriesFilter(btn.dataset.series));
      });
    }
    // Long-press (mobile) or right-click (desktop) to delete a series.
    pillsEl.querySelectorAll('[data-longpress]').forEach(el => {
      this._addLongPress(el, el.dataset.longpress);
    });
    pillsEl.querySelector('#btn-series-new')?.addEventListener('click', () => this._openNewSeriesModal());
  }

  _addLongPress(el, series) {
    const MS = 600;
    let timer = null, startX = 0, startY = 0;
    const trigger = () => {
      timer = null;
      el.classList.remove('series-pill-pressing');
      this._confirmDeleteSeries(series);
    };
    const start = (e) => {
      if (e.button === 2) return;
      startX = e.clientX; startY = e.clientY;
      el.classList.add('series-pill-pressing');
      timer = setTimeout(trigger, MS);
    };
    const cancel = () => {
      clearTimeout(timer); timer = null;
      el.classList.remove('series-pill-pressing');
    };
    el.addEventListener('pointerdown', start);
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointermove', (e) => {
      if (!timer) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (dx * dx + dy * dy > 100) cancel(); // cancel if finger moved > 10px
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault(); cancel(); this._confirmDeleteSeries(series);
    });
  }

  _openNewSeriesModal() {
    document.getElementById('mnewseries-name').value = '';
    this._openModal('modal-new-series');
    setTimeout(() => document.getElementById('mnewseries-name').focus(), 100);
  }

  _submitNewSeries() {
    const name = document.getElementById('mnewseries-name').value.trim();
    if (!name) { this._toast('Please enter a series name', 'error'); return; }
    this._closeModal('modal-new-series');
    if (!this._localSeries.includes(name)) {
      this._localSeries.push(name);
      try { localStorage.setItem('mm-local-series', JSON.stringify(this._localSeries)); } catch {}
    }
    this._setSeriesFilter(name);
  }

  _confirmDeleteSeries(series) {
    const count = this.sessions.all().filter(s => s.series === series).length;
    const hasPat = !!(typeof GitHubStore !== 'undefined' ? GitHubStore.getPat() : '') ||
      !!(this.sessions.constructor?.name === 'GitHubStore' ? true : false);
    const syncNote = this.sessions.deleteSeries && this.sessions.constructor?.name !== 'SessionStore'
      ? ' Synced data will be removed from GitHub.'
      : '';
    document.getElementById('mdel-series-name').textContent = series;
    document.getElementById('mdel-session-count').textContent =
      count === 0 ? 'no sessions' : `${count} session${count !== 1 ? 's' : ''}`;
    document.getElementById('mdel-sync-note').textContent = syncNote;
    this._pendingDeleteSeries = series;
    this._openModal('modal-del-series');
  }

  async _executeDeleteSeries() {
    const series = this._pendingDeleteSeries;
    if (!series) return;
    this._pendingDeleteSeries = null;
    this._closeModal('modal-del-series');

    // Remove from locally-tracked series
    this._localSeries = this._localSeries.filter(s => s !== series);
    try { localStorage.setItem('mm-local-series', JSON.stringify(this._localSeries)); } catch {}

    // Clear any draft that belongs to this series
    if (this.sessions.getDraft?.()?.series === series) this.sessions.clearDraft?.();

    try {
      await this.sessions.deleteSeries?.(series);
    } catch {
      this._toast(`Could not sync deletion to GitHub`, 'error');
      return;
    }

    // Switch away from the deleted series
    if (this._selectedSeries === series) {
      const remaining = [...this.sessions.knownSeries(), ...this._localSeries].filter(s => s !== series);
      this._setSeriesFilter(remaining[0] || null);
    } else {
      this._renderSeriesStrip();
      this._route();
    }
    this._toast(`"${series}" deleted`, 'success');
  }

  // ─── Refresh ──────────────────────────────────────────────────────────────

  async _refreshData() {
    const btn = document.getElementById('btn-refresh');
    if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
    try {
      await this.sessions.load(true);
      this._initSeriesFilter();
      this._route();
      this._toast('Data refreshed', 'success');
    } catch {
      this._toast('Refresh failed', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
    }
  }

  // ─── Global bindings ──────────────────────────────────────────────────────

  _bindGlobal() {
    // Refresh button
    document.getElementById('btn-refresh')?.addEventListener('click', () => this._refreshData());

    // Dashboard
    document.getElementById('btn-dash-new-session')?.addEventListener('click', () => this._openNewSession());
    document.getElementById('btn-dash-join-session')?.addEventListener('click', () => this._openJoinModal());
    document.getElementById('btn-dash-goto-live')?.addEventListener('click', () => { location.hash = '#session'; });

    // Browse — debounce typing to avoid Levenshtein search on every keystroke;
    // 'search' covers the clear-X button which should respond immediately.
    const browseSearch = document.getElementById('browse-search');
    browseSearch?.addEventListener('input', () => {
      clearTimeout(this._browseSearchTimer);
      this._browseSearchTimer = setTimeout(() => this._applyBrowseFilters(), 220);
    });
    browseSearch?.addEventListener('search', () => this._applyBrowseFilters());
    document.getElementById('filter-deity')?.addEventListener('change', () => this._applyBrowseFilters());
    document.getElementById('filter-language')?.addEventListener('change', () => this._applyBrowseFilters());
    document.getElementById('filter-tempo')?.addEventListener('change', () => this._applyBrowseFilters());
    document.getElementById('filter-level')?.addEventListener('change', () => this._applyBrowseFilters());

    // History
    document.getElementById('btn-add-backdated')?.addEventListener('click', () => this._openNewSession(true));
    document.getElementById('btn-history-back')?.addEventListener('click', () => { location.hash = '#dashboard'; });

    // Singers directory back
    document.getElementById('btn-singers-back')?.addEventListener('click', () => { location.hash = '#dashboard'; });

    // Sung bhajans back
    document.getElementById('btn-sung-back')?.addEventListener('click', () => { location.hash = '#dashboard'; });

    // Browse sung/singer filter
    document.getElementById('filter-sung')?.addEventListener('change', () => this._applyBrowseFilters());

    // Singer profile back
    document.getElementById('btn-singer-back')?.addEventListener('click', () => history.back());
    document.getElementById('btn-session-detail-back')?.addEventListener('click', () => { location.hash = '#history'; });

    // Bhajan modal
    document.getElementById('mbhajan-close')?.addEventListener('click', () => this._closeBhajanModal());
    document.getElementById('modal-bhajan')?.addEventListener('click', e => {
      if (e.target === document.getElementById('modal-bhajan')) this._closeBhajanModal();
    });
    document.getElementById('mbhajan-add-to-session')?.addEventListener('click', () => {
      const id = document.getElementById('mbhajan-add-to-session').dataset.bhajanId;
      this._closeBhajanModal();
      if (!this.liveState) {
        this._toast('No active session. Start a session first.', 'warn');
        return;
      }
      if (this.liveState.phase === 'playing') {
        this._toast('Session is playing — exit play mode to add bhajans.', 'warn');
        return;
      }
      const bhajan = this.bhajans.getById(id);
      if (bhajan) this._openAddBhajanModal(bhajan);
    });
    document.getElementById('mbhajan-prev')?.addEventListener('click', () => {
      const ctx = this._bhajanModalContext;
      if (!ctx || ctx.index <= 0) return;
      const newIdx = ctx.index - 1;
      this._openBhajanModal(ctx.bhajans[newIdx], { ...ctx, index: newIdx });
    });
    document.getElementById('mbhajan-next')?.addEventListener('click', () => {
      const ctx = this._bhajanModalContext;
      if (!ctx || ctx.index >= ctx.bhajans.length - 1) return;
      const newIdx = ctx.index + 1;
      this._openBhajanModal(ctx.bhajans[newIdx], { ...ctx, index: newIdx });
    });

    // Session form modal
    document.getElementById('mform-close')?.addEventListener('click', () => this._closeModal('modal-session-form'));
    document.getElementById('btn-mform-cancel')?.addEventListener('click', () => this._closeModal('modal-session-form'));
    document.getElementById('modal-session-form')?.addEventListener('click', e => {
      if (e.target === document.getElementById('modal-session-form')) this._closeModal('modal-session-form');
    });
    document.getElementById('btn-mform-submit')?.addEventListener('click', () => this._submitSessionForm());
    // New Series modal
    document.getElementById('mnewseries-close')?.addEventListener('click', () => this._closeModal('modal-new-series'));
    document.getElementById('btn-mnewseries-cancel')?.addEventListener('click', () => this._closeModal('modal-new-series'));
    document.getElementById('btn-mnewseries-create')?.addEventListener('click', () => this._submitNewSeries());
    document.getElementById('mnewseries-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') this._submitNewSeries(); });
    document.getElementById('modal-new-series')?.addEventListener('click', e => {
      if (e.target === document.getElementById('modal-new-series')) this._closeModal('modal-new-series');
    });
    // Delete Series modal
    document.getElementById('btn-mdel-cancel')?.addEventListener('click', () => this._closeModal('modal-del-series'));
    document.getElementById('btn-mdel-confirm')?.addEventListener('click', () => this._executeDeleteSeries());
    document.getElementById('modal-del-series')?.addEventListener('click', e => {
      if (e.target === document.getElementById('modal-del-series')) this._closeModal('modal-del-series');
    });
    // Add Bhajan modal
    document.getElementById('mab-close')?.addEventListener('click', () => this._closeModal('modal-add-bhajan'));
    document.getElementById('btn-mab-cancel')?.addEventListener('click', () => this._closeModal('modal-add-bhajan'));
    document.getElementById('modal-add-bhajan')?.addEventListener('click', e => {
      if (e.target === document.getElementById('modal-add-bhajan')) this._closeModal('modal-add-bhajan');
    });
    document.getElementById('mab-search')?.addEventListener('input', () => this._mabSearch());
    document.getElementById('btn-mab-back')?.addEventListener('click', () => this._mabGoStep(1));
    document.getElementById('btn-mab-add')?.addEventListener('click', () => this._mabConfirmAdd());
    document.getElementById('btn-pitch-gents')?.addEventListener('click', () => {
      const b = this._mabSelected;
      if (b?.gents_pitch) this._setMabPitch(b.gents_pitch);
    });
    document.getElementById('btn-pitch-ladies')?.addEventListener('click', () => {
      const b = this._mabSelected;
      if (b?.ladies_pitch) this._setMabPitch(b.ladies_pitch);
    });
    // Dual pitch selects — bidirectional linking
    document.getElementById('mab-pitch-indian')?.addEventListener('change', e => {
      const p = pitchByIndian(e.target.value);
      document.getElementById('mab-pitch-western').value = p?.western || '';
      document.getElementById('mab-pitch').value         = p?.combined || '';
    });
    document.getElementById('mab-pitch-western')?.addEventListener('change', e => {
      const series = pitchByIndian(document.getElementById('mab-pitch-indian').value)?.series || 'Pancham';
      const p = pitchByWestern(e.target.value, series);
      document.getElementById('mab-pitch-indian').value = p?.indian || '';
      document.getElementById('mab-pitch').value        = p?.combined || '';
    });
    const singerInp = document.getElementById('mab-singer');
    if (singerInp) {
      singerInp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); this._mabAddSingerFromInput(); }
        if (e.key === 'Backspace' && !singerInp.value && this._mabSingers.length) {
          this._mabSingers.pop();
          this._mabRenderSingerChips();
          this._mabUpdatePitchHint();
          this._mabUpdateSuggChips();
        }
      });
      singerInp.addEventListener('input', () => {
        if (singerInp.value.includes(',')) {
          singerInp.value = singerInp.value.replace(/,/g, '').trim();
          this._mabAddSingerFromInput();
        }
      });
      // datalist selection fires 'change' in most browsers
      singerInp.addEventListener('change', () => {
        if (singerInp.value.trim()) this._mabAddSingerFromInput();
      });
    }

    // Join modal
    document.getElementById('mjoin-close')?.addEventListener('click', () => this._closeModal('modal-join-session'));
    document.getElementById('btn-mjoin-cancel')?.addEventListener('click', () => this._closeModal('modal-join-session'));
    document.getElementById('btn-mjoin-join')?.addEventListener('click', () => this._joinSession());
    document.getElementById('mjoin-date')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._joinSession();
    });
    document.getElementById('modal-join-session')?.addEventListener('click', e => {
      if (e.target === document.getElementById('modal-join-session')) this._closeModal('modal-join-session');
    });
  }

  _openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  _closeModal(id) {
    document.getElementById(id).classList.add('hidden');
    const cleanup = this._modalCleanup?.[id];
    if (cleanup) {
      delete this._modalCleanup[id];
      cleanup();
    }
  }

  _initKeyboardAdjust() {
    if (!window.visualViewport) return;
    window.visualViewport.addEventListener('resize', () => {
      const vh = window.visualViewport.height;
      document.querySelectorAll('.modal-overlay:not(.hidden) .modal-box').forEach(box => {
        box.style.maxHeight = `${Math.floor(vh - 16)}px`;
      });
      const focused = document.activeElement;
      if (focused && focused.closest('.modal-overlay:not(.hidden)')) {
        setTimeout(() => focused.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
      }
    });
  }

  // ─── Sync indicator ───────────────────────────────────────────────────────

  _onSyncChange(status, message) {
    this._updateSyncIndicator(status);
    if (status === 'error') this._toast(`Sync error: ${message}`, 'error');
  }

  _updateSyncIndicator(status) {
    const dot = document.getElementById('sync-indicator');
    if (!dot) return;
    dot.className = `sync-dot sync-${status}`;
    const titles = { idle: 'Not connected', syncing: 'Syncing…', ok: 'Synced to GitHub', error: 'Sync error', local: 'Local storage only', pending: 'Unsaved changes — tap Save' };
    dot.title = titles[status] || status;
  }

  // ─── Settings Modal ───────────────────────────────────────────────────────

  _bindSettings() {
    document.getElementById('btn-settings').addEventListener('click', () => this._openSettings());
    document.getElementById('msettings-close').addEventListener('click', () => this._closeModal('modal-settings'));
    document.getElementById('btn-settings-cancel').addEventListener('click', () => this._closeModal('modal-settings'));
    document.getElementById('modal-settings').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-settings')) this._closeModal('modal-settings');
    });
    document.getElementById('btn-settings-save').addEventListener('click', () => this._savePatSettings());
    document.getElementById('btn-clear-pat').addEventListener('click', () => this._clearPat());
    document.getElementById('btn-add-alias')?.addEventListener('click', () => {
      const from = document.getElementById('alias-from').value.trim();
      const to   = document.getElementById('alias-to').value.trim();
      if (!from || !to) { this._toast('Enter both variant and canonical name', 'warn'); return; }
      if (from === to) { this._toast('Names must be different', 'warn'); return; }
      if (!this._addAlias(from, to)) { this._toast('Cannot add alias — would create a cycle', 'warn'); return; }
      document.getElementById('alias-from').value = '';
      document.getElementById('alias-to').value = '';
      this._renderAliasList();
      this._toast(`"${from}" will now count as "${to}"`, 'success');
    });
    document.getElementById('btn-migrate')?.addEventListener('click', () => this._migrateLocalToGitHub());
    document.getElementById('btn-settings-toggle-pat').addEventListener('click', () => {
      const inp = document.getElementById('settings-pat');
      const btn = document.getElementById('btn-settings-toggle-pat');
      if (inp.type === 'password') { inp.type = 'text'; btn.textContent = 'Hide token'; }
      else { inp.type = 'password'; btn.textContent = 'Show token'; }
    });
  }

  _openSettings() {
    const pat = GitHubStore.getPat();
    document.getElementById('settings-pat').value = pat ? '••••••••••••••••' : '';
    document.getElementById('settings-pat').dataset.hasExisting = pat ? 'true' : 'false';
    document.getElementById('settings-pat').type = 'password';
    document.getElementById('btn-settings-toggle-pat').textContent = 'Show token';

    // Status banner
    const banner = document.getElementById('sync-status-banner');
    if (pat) {
      const last = GitHubStore.lastSynced();
      const msg = last ? `Connected · Last synced ${last.toLocaleString()}` : 'Connected to GitHub';
      banner.className = 'sync-banner sync-banner-ok';
      banner.textContent = `✓ ${msg}`;
      banner.classList.remove('hidden');
    } else {
      banner.className = 'sync-banner sync-banner-info';
      banner.textContent = 'ℹ Session history is saved locally only on this device';
      banner.classList.remove('hidden');
    }

    // Last sync time
    const last = GitHubStore.lastSynced();
    document.getElementById('settings-last-sync').textContent = last
      ? `Last synced: ${last.toLocaleString()}` : '';

    // PAT status
    const statusEl = document.getElementById('settings-pat-status');
    statusEl.className = 'pat-status hidden';

    // Migrate row: show if there are local sessions not on GitHub
    // (show whenever we're not using GitHub store, as a convenience)
    const migrateRow = document.getElementById('settings-migrate-row');
    const localSessions = new SessionStore().all();
    migrateRow.classList.toggle('hidden', !(localSessions.length && !pat));

    // Singer alias management
    this._renderAliasList();
    const allSingers = this.sessions.allSingerNames?.() || [];
    const canonSingers = [...new Set(allSingers.map(n => this._canonName(n)))].sort();
    const datalistOpts = singerNames => singerNames.map(n => `<option value="${escHtml(n)}">`).join('');
    document.getElementById('alias-from-list').innerHTML = datalistOpts(allSingers);
    document.getElementById('alias-to-list').innerHTML = datalistOpts(canonSingers);

    this._openModal('modal-settings');
    if (!pat) setTimeout(() => document.getElementById('settings-pat').focus(), 100);
  }

  _renderAliasList() {
    const listEl = document.getElementById('settings-alias-list');
    if (!listEl) return;
    const entries = Object.entries(this._singerAliases);
    if (!entries.length) {
      listEl.innerHTML = '<div class="alias-empty">No aliases set</div>';
      return;
    }
    listEl.innerHTML = entries.map(([from, to]) => `
      <div class="alias-item" data-from="${escHtml(from)}">
        <span class="alias-from-name">${escHtml(from)}</span>
        <span class="alias-arrow">→</span>
        <span class="alias-canonical">${escHtml(to)}</span>
        <button class="alias-delete" data-from="${escHtml(from)}" title="Remove alias">×</button>
      </div>`).join('');
    listEl.querySelectorAll('.alias-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        this._removeAlias(btn.dataset.from);
        this._renderAliasList();
      });
    });
  }

  async _savePatSettings() {
    const input = document.getElementById('settings-pat');
    const rawVal = input.value.trim();
    const statusEl = document.getElementById('settings-pat-status');

    // If unchanged placeholder, just close
    if (rawVal === '••••••••••••••••' && input.dataset.hasExisting === 'true') {
      this._closeModal('modal-settings');
      return;
    }

    if (!rawVal) { this._toast('Please enter a token', 'warn'); return; }

    // Test the PAT
    statusEl.className = 'pat-status pat-testing';
    statusEl.textContent = 'Testing token…';
    statusEl.classList.remove('hidden');
    document.getElementById('btn-settings-save').disabled = true;

    try {
      await GitHubStore.testPat(rawVal);
    } catch (err) {
      statusEl.className = 'pat-status pat-error';
      statusEl.textContent = `✗ ${err.message}`;
      document.getElementById('btn-settings-save').disabled = false;
      return;
    }

    statusEl.className = 'pat-status pat-ok';
    statusEl.textContent = '✓ Token valid!';

    // Save PAT and switch to GitHub store
    GitHubStore.setPat(rawVal);
    const ghStore = new GitHubStore(rawVal);
    ghStore.onSyncChange = (status, msg) => this._onSyncChange(status, msg);

    // Migrate any existing local sessions before switching
    const localStore = new SessionStore();
    const localSessions = localStore.all();

    this.sessions = ghStore;
    this._updateSyncIndicator('syncing');

    // Initial load from GitHub (merges with local)
    await this.sessions.load();

    // Ensure any local sessions that weren't on GitHub are pushed
    if (localSessions.length) {
      for (const s of localSessions) {
        if (!this.sessions.get(s.id)) this.sessions.save(s);
      }
    }

    document.getElementById('btn-settings-save').disabled = false;
    this._closeModal('modal-settings');
    this._toast('Connected to GitHub — sessions synced!', 'success');
    this._route(); // re-render current view with fresh data
  }

  _clearPat() {
    if (!confirm('Stop syncing to GitHub? Sessions will still be stored locally on this device.')) return;
    GitHubStore.clearPat();
    this.sessions = new SessionStore();
    this._updateSyncIndicator('local');
    this._closeModal('modal-settings');
    this._toast('Disconnected from GitHub');
  }

  async _migrateLocalToGitHub() {
    const pat = document.getElementById('settings-pat').value.trim();
    if (!pat || pat === '••••••••••••••••') {
      this._toast('Save your token first', 'warn');
      return;
    }
    // Just trigger save — handled in _savePatSettings
    this._savePatSettings();
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────

  _renderDashboard() {
    // Date / greeting
    const now = new Date();
    const greeting = 'Sairam 🙏';
    document.getElementById('dash-greeting').textContent = greeting;
    document.getElementById('dash-date').textContent = now.toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });

    // Stats
    const s = this.sessions.stats();
    document.getElementById('stat-sessions').textContent    = s.total;
    document.getElementById('stat-bhajans-sung').textContent = s.totalBhajans;
    document.getElementById('stat-singers').textContent      = s.singers;
    document.getElementById('stat-this-month').textContent   = s.thisMonth;

    // Stat cards → navigate to respective views
    document.getElementById('stat-sessions-card')?.addEventListener('click', () => { location.hash = '#history'; }, { once: true });
    document.getElementById('stat-bhajans-card')?.addEventListener('click', () => { location.hash = '#sung'; }, { once: true });
    document.getElementById('stat-singers-card')?.addEventListener('click', () => { location.hash = '#singers'; }, { once: true });

    // Live alert
    const liveAlert = document.getElementById('dash-live-alert');
    if (this.liveState) {
      liveAlert.classList.remove('hidden');
      document.getElementById('dash-live-text').textContent =
        `Live: ${this.liveState.label || 'Bhajan Session'} · ${(this.liveState.bhajans || []).length} bhajans`;
    } else {
      liveAlert.classList.add('hidden');
    }

    // Period tabs — must bind before chart so fromDate is ready
    document.querySelectorAll('#dash-period-tabs .period-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.period === this._dashPeriod);
      btn.onclick = () => { this._dashPeriod = btn.dataset.period; this._renderDashboard(); };
    });

    const fromDate = this._periodFromDate(this._dashPeriod);

    // Activity chart — weekly for 3M/6M, monthly for 1Y/All Time
    const isMonthly = this._dashPeriod === 'all' || this._dashPeriod === '1y';
    const activity = isMonthly
      ? this.sessions.activityByMonth(12)
      : this.sessions.activityByWeek(this._dashPeriod === '6m' ? 26 : 13);
    const maxCount = Math.max(...activity.map(w => w.count), 1);
    const barsEl = document.getElementById('dash-activity-bars');
    barsEl.innerHTML = `<div class="activity-chart-wrap">
      <div class="activity-bars">
        ${activity.map(w => `<div class="activity-bar-col">
          <div class="activity-bar ${w.count > 0 ? 'has-data' : ''}"
            style="height:${Math.max(4, (w.count / maxCount) * 56)}px"
            title="${isMonthly ? w.label : 'Week of ' + w.label}: ${w.count} bhajan${w.count !== 1 ? 's' : ''}"></div>
        </div>`).join('')}
      </div>
      <div class="activity-bar-labels">
        ${activity.map((w, i) => {
          const showLabel = isMonthly || i === 0 || activity[i - 1].month !== w.month;
          return `<div class="activity-bar-label-col">${showLabel ? w.month : ''}</div>`;
        }).join('')}
      </div>
    </div>`;

    // Top bhajans (time-filtered)
    const top = this.sessions.topBhajansFrom(5, fromDate);
    const maxBhajan = top[0]?.count || 1;
    document.getElementById('dash-top-bhajans').innerHTML = top.length
      ? `<ul class="rank-list">${top.map((b, i) => `
          <li class="rank-item">
            <span class="rank-num">${i + 1}</span>
            <span class="rank-name" title="${escHtml(b.title)}">${escHtml(b.title)}</span>
            <div class="rank-bar-wrap"><div class="rank-bar" style="width:${(b.count / maxBhajan) * 100}%"></div></div>
            <span class="rank-count">${b.count}×</span>
          </li>`).join('')}</ul>`
      : '<p class="text-muted text-small">No data for this period</p>';

    // Top singers (time-filtered, merge aliases into canonical names)
    const singers = this._canonSingers(this.sessions.topSingersFrom(20, fromDate)).slice(0, 5);
    const maxSinger = singers[0]?.count || 1;
    document.getElementById('dash-top-singers').innerHTML = singers.length
      ? `<ul class="rank-list">${singers.map((s, i) => `
          <li class="rank-item">
            <span class="rank-num">${i + 1}</span>
            <a href="#singer/${encodeURIComponent(s.name)}" class="rank-name">${escHtml(s.name)}</a>
            <div class="rank-bar-wrap"><div class="rank-bar" style="width:${(s.count / maxSinger) * 100}%"></div></div>
            <span class="rank-count">${s.count}</span>
          </li>`).join('')}</ul>`
      : '<p class="text-muted text-small">No data for this period</p>';

    // Deity distribution
    const deities = this.sessions.deityDistribution();
    const maxDeity = deities[0]?.count || 1;
    document.getElementById('dash-deities').innerHTML = deities.length
      ? `<ul class="rank-list">${deities.map((d) => `
          <li class="rank-item">
            <span class="rank-name deity-label deity-${this._deitySlug(d.name)}">${escHtml(d.name)}</span>
            <div class="rank-bar-wrap"><div class="rank-bar deity-bar-accent deity-fill-${this._deitySlug(d.name)}" style="width:${(d.count / maxDeity) * 100}%"></div></div>
            <span class="rank-count">${d.count}</span>
          </li>`).join('')}</ul>`
      : '<p class="text-muted text-small">No sessions yet</p>';

    // Recent sessions
    const recent = this.sessions.activeAll().slice(0, 4);
    document.getElementById('dash-recent-sessions').innerHTML = recent.length
      ? recent.map(s => this._sessionCardHTML(s)).join('')
      : `<div class="empty-state"><div class="empty-icon">📅</div><p>No sessions recorded yet. Start one!</p></div>`;

    // Click on session cards (singer links inside handle their own navigation)
    document.querySelectorAll('#dash-recent-sessions .session-card').forEach(el => {
      el.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        location.hash = `#session-detail/${el.dataset.id}`;
      });
    });
  }

  _sessionCardHTML(s) {
    const singers = s.singers || [];
    const bCount = (s.bhajans || []).length;
    const badge = s.status === 'live'
      ? `<span class="session-card-badge badge-live">LIVE</span>`
      : s.isBackdated
      ? `<span class="session-card-badge badge-backdated">Backdated</span>`
      : `<span class="session-card-badge badge-completed">${bCount} bhajans</span>`;

    const singerLinks = singers.slice(0, 3)
      .map(n => `<a href="#singer/${encodeURIComponent(this._canonName(n))}" class="singer-link">${escHtml(n)}</a>`)
      .join(', ');
    const singerExtra = singers.length > 3 ? ` +${singers.length - 3}` : '';

    return `<div class="session-card" data-id="${s.id}">
      <div class="session-card-header">
        <div>
          <div class="session-card-date">${formatDate(s.date)}</div>
          <div class="session-card-label">${escHtml(s.label || 'Bhajan Session')}</div>
        </div>
        ${badge}
      </div>
      <div class="session-card-meta">
        ${singerLinks ? `<span class="session-meta-item session-meta-singers">👥 ${singerLinks}${singerExtra}</span>` : ''}
        <span class="session-meta-item">🎵 ${bCount} bhajan${bCount !== 1 ? 's' : ''}</span>
        ${s.duration ? `<span class="session-meta-item">⏱ ${this._formatDuration(s.duration)}</span>` : ''}
      </div>
    </div>`;
  }

  _formatDuration(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  _seriesSlug(name) {
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  _sessionRoomCode(series, date) {
    const slug = this._seriesSlug(series);
    return slug ? `${slug}-${date}` : date;
  }

  async _fetchKnownSeries() {
    const series = new Set(this.sessions.knownSeries?.() || []);
    try {
      const res = await fetch('./data/series.json');
      if (res.ok) {
        const defaults = await res.json();
        if (Array.isArray(defaults)) defaults.forEach(s => series.add(s));
      }
    } catch {}
    return [...series].sort();
  }

  _populateSeriesSelect(select, series, includeNew) {
    const opts = series.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');
    const newOpt = includeNew ? '<option value="__new__">— New series —</option>' : '';
    select.innerHTML = opts + newOpt;
    if (series.length) {
      const preferred = this._selectedSeries && series.includes(this._selectedSeries)
        ? this._selectedSeries : series[0];
      select.value = preferred;
    }
  }

  _moveBhajanEntry(entryId, direction, bhajansArray) {
    const idx = bhajansArray.findIndex(e => e.id === entryId);
    if (idx < 0) return bhajansArray;
    const newIdx = direction === 'earlier' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= bhajansArray.length) return bhajansArray;
    const arr = [...bhajansArray];
    [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
    return arr;
  }

  _initDragReorder(listEl) {
    if (!listEl) return;
    let dragSrc = null, overTarget = null;

    const rows = () => [...listEl.querySelectorAll('.session-bhajan-entry[data-entry-id]')];

    const clearClasses = () => rows().forEach(r =>
      r.classList.remove('dragging', 'drag-over-above', 'drag-over-below'));

    const cancel = () => { clearClasses(); dragSrc = null; overTarget = null; };

    listEl.querySelectorAll('.drag-handle').forEach(handle => {
      handle.addEventListener('pointerdown', e => {
        if (e.button > 0) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        dragSrc = handle.closest('.session-bhajan-entry');
        dragSrc?.classList.add('dragging');
      }, { passive: false });

      handle.addEventListener('pointermove', e => {
        if (!dragSrc) return;
        e.preventDefault();
        const others = rows().filter(r => r !== dragSrc);
        let newTarget = null;
        for (const row of others) {
          const { top, height } = row.getBoundingClientRect();
          if (e.clientY < top + height / 2) { newTarget = row; break; }
        }
        if (newTarget !== overTarget) {
          clearClasses();
          dragSrc.classList.add('dragging');
          overTarget = newTarget;
          if (overTarget) overTarget.classList.add('drag-over-above');
          else if (others.length) others[others.length - 1].classList.add('drag-over-below');
        }
      }, { passive: false });

      const drop = () => {
        if (!dragSrc) return;
        const srcId = dragSrc.dataset.entryId;
        const bhajans = this.liveState?.bhajans || [];
        const src = bhajans.find(b => b.id === srcId);
        if (!src) { cancel(); return; }

        const without = bhajans.filter(b => b.id !== srcId);
        let newBhajans;
        if (!overTarget) {
          newBhajans = [...without, src];
        } else {
          const tIdx = without.findIndex(b => b.id === overTarget.dataset.entryId);
          newBhajans = tIdx < 0 ? [...without, src]
            : [...without.slice(0, tIdx), src, ...without.slice(tIdx)];
        }

        cancel();
        if (newBhajans.map(b => b.id).join() !== bhajans.map(b => b.id).join()) {
          const updated = { ...this.liveState, bhajans: newBhajans };
          this._applyLiveEdit(updated, { type: 'reorder-full', order: newBhajans.map(b => b.id) });
          this._renderSession();
        }
      };

      handle.addEventListener('pointerup', drop);
      handle.addEventListener('pointercancel', cancel);
    });
  }

  // ─── Browse ───────────────────────────────────────────────────────────────

  _populateFilters() {
    const deityEl    = document.getElementById('filter-deity');
    const langEl     = document.getElementById('filter-language');
    const tempoEl    = document.getElementById('filter-tempo');
    const levelEl    = document.getElementById('filter-level');

    const deities = this.bhajans.uniqueValues('deity');
    const langs   = this.bhajans.uniqueValues('language');
    const tempos  = ['Slow', 'Medium Slow', 'Medium', 'Medium Fast', 'Fast'];
    const levels  = ['Simple', 'Intermediate', 'Advanced'];

    deities.forEach(d => deityEl.append(new Option(d, d)));
    langs.forEach(l => langEl.append(new Option(l, l)));
    tempos.forEach(t => tempoEl.append(new Option(t, t)));
    levels.forEach(l => levelEl.append(new Option(l, l)));
  }

  _renderBrowse() {
    this._bhajanCounts = this.sessions.bhajanSungCounts();

    // Populate sung/singer filter (dynamic — depends on session data)
    const sungEl = document.getElementById('filter-sung');
    if (sungEl) {
      const prev = sungEl.value;
      const singers = this._canonSingers(this.sessions.topSingersFrom(200)).map(s => s.name).sort();
      sungEl.innerHTML = `<option value="">All Bhajans</option>
        <option value="sung">Sung Bhajans</option>
        <optgroup label="By Singer">
          ${singers.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('')}
        </optgroup>`;
      if (prev) sungEl.value = prev;
    }

    this._applyBrowseFilters();
  }

  _applyBrowseFilters() {
    const q        = document.getElementById('browse-search').value;
    const deity    = document.getElementById('filter-deity').value;
    const language = document.getElementById('filter-language').value;
    const tempo    = document.getElementById('filter-tempo').value;
    const level    = document.getElementById('filter-level').value;
    const sung     = document.getElementById('filter-sung')?.value || '';

    this._browseFiltered = this.bhajans.search(q, { deity, language, tempo, level });

    if (sung) {
      const sungIds = this._sungIdsForFilter(sung);
      this._browseFiltered = this._browseFiltered.filter(b => sungIds.has(b.id));
      // Sort by sung count (most first) when no text query
      if (!q) {
        const counts = this._bhajanCounts || {};
        this._browseFiltered.sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));
      }
    }

    this._browsePage = 0;
    document.getElementById('browse-count-badge').textContent = this._browseFiltered.length;
    this._renderBrowsePage();
  }

  _sungIdsForFilter(value) {
    const ids = new Set();
    if (value === 'sung') {
      for (const s of this.sessions.activeAll())
        for (const e of (s.bhajans || []))
          if (e.bhajan_id) ids.add(e.bhajan_id);
    } else {
      // Specific canonical singer — include all alias names
      const aliases = Object.entries(this._singerAliases)
        .filter(([, canon]) => canon === value)
        .map(([alias]) => alias);
      const allNames = new Set([value, ...aliases]);
      for (const s of this.sessions.activeAll())
        for (const e of (s.bhajans || []))
          if ((e.singers || (e.singer ? [e.singer] : [])).some(n => allNames.has(n)))
            if (e.bhajan_id) ids.add(e.bhajan_id);
    }
    return ids;
  }

  _renderBrowsePage(scrollToList = false) {
    const PAGE = 30;
    const results = this._browseFiltered;
    const totalPages = Math.max(1, Math.ceil(results.length / PAGE));
    const page  = Math.min(this._browsePage, totalPages - 1);
    const start = page * PAGE;
    const end   = Math.min(start + PAGE, results.length);

    this._renderBrowseList(results.slice(start, end));

    if (results.length > PAGE) {
      document.getElementById('browse-list').insertAdjacentHTML('beforeend', `
        <div class="browse-pagination">
          <button class="btn browse-pg-btn" id="browse-pg-prev" ${page === 0 ? 'disabled' : ''}>&#8249; Prev</button>
          <span class="browse-pg-info">${start + 1}–${end} of ${results.length}</span>
          <button class="btn browse-pg-btn" id="browse-pg-next" ${page >= totalPages - 1 ? 'disabled' : ''}>Next &#8250;</button>
        </div>`);

      document.getElementById('browse-pg-prev')?.addEventListener('click', () => {
        this._browsePage = Math.max(0, page - 1);
        this._renderBrowsePage(true);
      });
      document.getElementById('browse-pg-next')?.addEventListener('click', () => {
        this._browsePage = Math.min(totalPages - 1, page + 1);
        this._renderBrowsePage(true);
      });
    }

    if (scrollToList) {
      document.getElementById('browse-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  _renderBrowseList(bhajans) {
    const el = document.getElementById('browse-list');
    if (!bhajans.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><p>No bhajans match your search</p></div>`;
      return;
    }
    el.innerHTML = bhajans.map(b => this._bhajanItemHTML(b)).join('');
    el.querySelectorAll('.bhajan-item').forEach(item => {
      item.addEventListener('click', () => this._openBhajanModal(item.dataset.id));
    });
  }

  _bhajanItemHTML(b) {
    const tempoClass = b.tempo
      ? 'bhajan-tag-tempo-' + (b.tempo.toLowerCase().includes('fast') ? 'fast' : b.tempo.toLowerCase().includes('slow') ? 'slow' : 'medium')
      : '';
    const levelClass = b.level ? 'bhajan-tag-level-' + b.level.toLowerCase() : '';
    const sungCount  = this._bhajanCounts?.[b.id] || 0;

    return `<div class="bhajan-item" data-id="${b.id}">
      <div class="bhajan-item-main">
        <div class="bhajan-item-title">${escHtml(b.title)}</div>
        <div class="bhajan-item-meta">${escHtml([b.deity, b.language].filter(Boolean).join(' · '))}</div>
        <div class="bhajan-item-tags">
          ${b.tempo ? `<span class="bhajan-tag ${tempoClass}">${escHtml(b.tempo)}</span>` : ''}
          ${b.level ? `<span class="bhajan-tag ${levelClass}">${escHtml(b.level)}</span>` : ''}
          ${b.raga ? `<span class="bhajan-tag">${escHtml(b.raga.split('/')[0].trim())}</span>` : ''}
          ${b.scale ? `<span class="bhajan-tag bhajan-tag-scale-${(b.scale||'').toLowerCase()}">${escHtml(b.scale)}</span>` : ''}
          ${sungCount ? `<span class="bhajan-tag bhajan-tag-sung">${sungCount}× sung</span>` : ''}
        </div>
      </div>
      <div class="bhajan-item-pitches">
        ${b.gents_pitch ? `<span class="pitch-badge pitch-gents" title="Gents pitch: ${escHtml(b.gents_pitch_indian||'')} / ${escHtml(b.gents_pitch_western||'')}">♂ ${escHtml(b.gents_pitch_indian || b.gents_pitch.split('/')[0].trim())}<span class="pitch-western"> ${escHtml(b.gents_pitch_western || b.gents_pitch.split('/')[1]?.trim() || '')}</span>${b.scale ? `<span class="pitch-scale"> ${escHtml(b.scale)}</span>` : ''}</span>` : ''}
        ${b.ladies_pitch ? `<span class="pitch-badge pitch-ladies" title="Ladies pitch: ${escHtml(b.ladies_pitch_indian||'')} / ${escHtml(b.ladies_pitch_western||'')}">♀ ${escHtml(b.ladies_pitch_indian || b.ladies_pitch.split('/')[0].trim())}<span class="pitch-western"> ${escHtml(b.ladies_pitch_western || b.ladies_pitch.split('/')[1]?.trim() || '')}</span>${b.scale ? `<span class="pitch-scale"> ${escHtml(b.scale)}</span>` : ''}</span>` : ''}
      </div>
    </div>`;
  }

  // ─── Sung Bhajans ─────────────────────────────────────────────────────────

  _renderSung() {
    this._bhajanCounts = this.sessions.bhajanSungCounts();
    const counts = this._bhajanCounts;
    const sorted = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => this.bhajans.getById(id))
      .filter(Boolean);

    document.getElementById('sung-count-badge').textContent = sorted.length;
    const el = document.getElementById('sung-list');
    if (!sorted.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">🎵</div><p>No bhajans sung yet. Start a session!</p></div>`;
      return;
    }
    el.innerHTML = sorted.map(b => this._bhajanItemHTML(b)).join('');
    el.querySelectorAll('.bhajan-item').forEach(item => {
      item.addEventListener('click', () => this._openBhajanModal(item.dataset.id));
    });
  }

  // ─── Bhajan Modal ─────────────────────────────────────────────────────────

  _openBhajanModal(id, context = null) {
    const b = this.bhajans.getById(id);
    if (!b) return;

    this._bhajanModalContext = context;

    const prevBtn = document.getElementById('mbhajan-prev');
    const nextBtn = document.getElementById('mbhajan-next');
    if (context && context.bhajans.length > 1) {
      prevBtn.classList.toggle('hidden', context.index <= 0);
      nextBtn.classList.toggle('hidden', context.index >= context.bhajans.length - 1);
    } else {
      prevBtn.classList.add('hidden');
      nextBtn.classList.add('hidden');
    }

    document.getElementById('mbhajan-title').textContent = b.title;
    document.getElementById('mbhajan-add-to-session').dataset.bhajanId = id;

    const canAdd = !!(this.liveState && this.liveState.phase === 'setup');
    document.getElementById('mbhajan-add-to-session').style.display = canAdd ? '' : 'none';

    const srcEl = document.getElementById('mbhajan-source-link');
    if (b.source_url) {
      srcEl.href = b.source_url;
      srcEl.style.display = '';
    } else {
      srcEl.style.display = 'none';
    }

    const fmtPitch = (indian, western) => {
      if (!indian && !western) return '';
      if (indian && western) return `${indian} · ${western}`;
      return indian || western;
    };
    const metaFields = [
      ['Deity', b.deity], ['Language', b.language], ['Raga', b.raga],
      ['Scale', b.scale],
      ['Beat', b.beat], ['Tempo', b.tempo], ['Level', b.level],
      ['Gents Pitch', [fmtPitch(b.gents_pitch_indian, b.gents_pitch_western) || b.gents_pitch, b.scale].filter(Boolean).join(' · ')],
      ['Ladies Pitch', [fmtPitch(b.ladies_pitch_indian, b.ladies_pitch_western) || b.ladies_pitch, b.scale].filter(Boolean).join(' · ')],
    ].filter(([, v]) => v);

    const history = this.sessions.bhajanHistory(b.id);

    document.getElementById('mbhajan-body').innerHTML = `
      <div class="bhajan-detail-meta">
        ${metaFields.map(([k, v]) => `
          <div class="detail-field">
            <div class="detail-label">${escHtml(k)}</div>
            <div class="detail-value">${escHtml(v)}</div>
          </div>`).join('')}
      </div>
      ${b.audio_url ? `
        <div class="audio-player">
          <span class="text-small text-muted">🎵 Listen:</span>
          <audio controls preload="none" src="${escHtml(b.audio_url)}"></audio>
        </div>` : ''}
      ${b.lyrics ? `
        <div class="bhajan-section-title">Lyrics</div>
        <div class="bhajan-lyrics">${escHtml(b.lyrics)}</div>` : ''}
      ${b.meaning ? `
        <div class="bhajan-section-title">Meaning</div>
        <div class="bhajan-meaning">${escHtml(b.meaning)}</div>` : ''}
      <div class="bhajan-section-title">Session History${history.length ? ` (${history.length})` : ''}</div>
      ${history.length ? `
        <div class="bhajan-history">
          ${history.map(h => {
            const pitch = [h.pitch_indian, h.pitch_western].filter(Boolean).join(' · ');
            return `<div class="bhajan-history-item">
              <span class="bh-date">${escHtml(formatDate(h.date))}${h.sessionLabel ? ` — ${escHtml(h.sessionLabel)}` : ''}</span>
              <div class="bh-details">
                ${h.singer ? `<span class="bh-singer">👤 ${escHtml(h.singer)}</span>` : ''}
                ${pitch    ? `<span class="bh-pitch">${escHtml(pitch)}</span>` : ''}
              </div>
            </div>`;
          }).join('')}
        </div>` :
        `<p class="text-muted text-small">Not recorded in any session yet</p>`}
    `;

    this._openModal('modal-bhajan');
  }

  _closeBhajanModal() {
    this._bhajanModalContext = null;
    this._closeModal('modal-bhajan');
    document.querySelector('#modal-bhajan audio')?.pause();
  }

  // ─── Session View ─────────────────────────────────────────────────────────

  _renderSession() {
    const el = document.getElementById('session-content');

    if (this.liveState) {
      this._renderLiveSession(el);
    } else {
      // Check for draft
      const draft = this.sessions.getDraft();
      el.innerHTML = this._sessionHomeHTML(draft);
      this._bindSessionHome(draft);
    }
  }

  _sessionHomeHTML(draft) {
    return `
      <div class="session-home">
        <div class="session-home-icon">🎵</div>
        <div class="session-home-title">Bhajan Session</div>
        <div class="session-home-desc">Start a session to record bhajans. Others can join by selecting the series and date.</div>
        <div class="session-home-actions">
          <button class="btn btn-primary btn-lg btn-block" id="btn-session-new">+ Start New Session</button>
          ${draft ? `<div style="width:100%">
            <button class="btn btn-warning btn-block" id="btn-session-resume">↩ Resume "${escHtml(draft.label || 'Previous Session')}"</button>
          </div>` : ''}
          <span class="session-home-or">— or join an existing one —</span>
          <button class="btn btn-outline btn-block" id="btn-session-join">Join Session →</button>
        </div>
      </div>`;
  }

  _bindSessionHome(draft) {
    document.getElementById('btn-session-new').addEventListener('click', () => this._openNewSession());
    document.getElementById('btn-session-join').addEventListener('click', () => this._openJoinModal());
    if (draft) {
      document.getElementById('btn-session-resume')?.addEventListener('click', () => this._resumeDraftSession(draft));
    }
  }

  _renderLiveSession(el) {
    const st = this.liveState;
    const isHost = this.live?.isHost;
    const phase = st.phase || 'setup';
    const isPlaying = phase === 'playing';

    el.innerHTML = `
      <div class="live-session-view">
        ${!isHost ? `<div class="observer-banner">${isPlaying ? '👁 Observer mode — watching live' : '✏️ Setup mode — add or arrange bhajans'}</div>` : ''}

        <div class="live-header">
          <div class="live-header-top">
            <div>
              <div class="live-session-label">${escHtml(st.label || 'Bhajan Session')}</div>
              <div class="live-session-date">${formatDate(st.date)}</div>
            </div>
          </div>
          <div class="observer-count" id="live-observer-count">
            ${isHost ? `${this.live?.peerCount || 0} observer${(this.live?.peerCount || 0) !== 1 ? 's' : ''}` : ''}
          </div>
          <div class="singers-strip">
            ${[...new Set((st.bhajans || []).flatMap(e => e.singers || (e.singer ? [e.singer] : [])))].map(name => `
              <div class="singer-chip clickable" data-singer="${escHtml(name)}" title="View ${escHtml(name)}'s profile">
                <div class="singer-avatar">${escHtml(name[0]?.toUpperCase() || '?')}</div>
                ${escHtml(name)}
              </div>`).join('')}
          </div>
        </div>

        ${!isPlaying ? `<div class="session-add-btn-row">
          <button class="btn btn-primary" id="btn-add-bhajan-live">+ Add Bhajan</button>
          ${isHost ? `<button class="btn btn-success" id="btn-start-playing" ${(st.bhajans || []).length === 0 ? 'disabled' : ''}>▶ Start</button>
          <button class="btn btn-outline" id="btn-end-session">End Session</button>
          <button class="btn btn-ghost btn-danger-ghost" id="btn-discard-session" title="Discard session without saving">Discard</button>` : ''}
        </div>` : `<div class="playing-controls-strip">
          ${isHost ? `
          <button class="btn btn-ghost btn-icon" id="btn-exit-play" title="Return to setup">↩</button>
          <button class="btn btn-ghost btn-icon" id="btn-end-session" title="End session">⏹</button>` : ''}
          <button class="btn btn-ghost btn-icon btn-aarati" id="btn-mangala-aarati" title="Mangala Aarati">🪔</button>
        </div>`}

        <div class="section-header section-header-flush">
          <h3 class="section-title">${isPlaying ? 'Sequence' : 'Bhajans'} (${(st.bhajans || []).length})</h3>
        </div>
        <div class="session-bhajans-list" id="live-bhajans-list">
          ${this._sessionBhajansHTML(st.bhajans || [], isHost, phase)}
        </div>

        ${!isHost ? '<div class="session-offline-note">🔄 Live updates as bhajans are added</div>' : ''}
      </div>`;

    // Singer chip clicks
    document.querySelectorAll('.singer-chip.clickable').forEach(chip => {
      chip.addEventListener('click', () => {
        location.hash = `#singer/${encodeURIComponent(chip.dataset.singer)}`;
      });
    });

    // Clickable bhajan titles (all users)
    document.querySelectorAll('#live-bhajans-list .entry-title-link').forEach(link => {
      link.addEventListener('click', () => {
        const bhajanIds = (st.bhajans || []).map(e => e.bhajan_id);
        const idx = parseInt(link.dataset.entryIdx);
        this._openBhajanModal(link.dataset.bhajanId, { bhajans: bhajanIds, index: idx });
      });
    });

    if (!isPlaying) {
      // Setup mode: all participants can edit
      document.getElementById('btn-add-bhajan-live').addEventListener('click', () => this._openAddBhajanModal());
      if (isHost) document.getElementById('btn-discard-session')?.addEventListener('click', () => this._discardSession());

      this._initDragReorder(document.getElementById('live-bhajans-list'));

      document.querySelectorAll('.entry-action-btn[data-action="remove"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this._removeBhajanEntry(btn.dataset.entryId);
        });
      });

      document.querySelectorAll('#live-bhajans-list .pitch-editable').forEach(pitchEl => {
        pitchEl.addEventListener('click', e => {
          e.stopPropagation();
          this._inlinePitchEdit(pitchEl, pitchEl.dataset.entryId, 'live');
        });
      });

      document.querySelectorAll('#live-bhajans-list .notes-editable').forEach(notesEl => {
        notesEl.addEventListener('click', e => {
          e.stopPropagation();
          this._inlineNotesEdit(notesEl, notesEl.dataset.entryId, 'live');
        });
      });

      // Setup controls: host only
      if (isHost) {
        document.getElementById('btn-start-playing').addEventListener('click', () => this._startPlaying());
        document.getElementById('btn-end-session').addEventListener('click', () => this._confirmEndSession());
      }
    } else {
      // Playing phase — Prev/Next are now inside the expanded list entry
      if (isHost) {
        document.getElementById('btn-prev-bhajan')?.addEventListener('click', () => this._prevBhajan());
        document.getElementById('btn-next-bhajan')?.addEventListener('click', () => this._nextBhajan());
        document.getElementById('btn-exit-play').addEventListener('click', () => this._exitPlay());
        document.getElementById('btn-end-session').addEventListener('click', () => this._confirmEndSession());
      }
      // Mangala Aarati visible to all in playing phase
      document.getElementById('btn-mangala-aarati').addEventListener('click', () => this._openBhajanModal('mangala-aarati'));
    }

    document.getElementById('bnav-session-icon').classList.add('is-live');
  }

  _nowSingingHTML(st) {
    const currentId = st.currentBhajan;
    const entry = currentId ? (st.bhajans || []).find(e => e.id === currentId) : (st.bhajans || []).at(-1);
    if (!entry) return '<span class="now-singing-empty">Session started — add first bhajan</span>';

    const bhajan = this.bhajans.getById(entry.bhajan_id);
    const lyrics = bhajan?.lyrics || '';
    const scale  = bhajan?.scale  || '';

    const pitchDisplay = entry.pitch
      ? [entry.pitch_indian || entry.pitch.split(' / ')[0], entry.pitch_western || entry.pitch.split(' / ')[1], scale]
          .filter(Boolean).join(' · ')
      : '';

    return `<div class="now-singing-info">
      <div class="now-singing-bhajan-title">${escHtml(entry.bhajan_title)}</div>
      <div class="now-singing-bhajan-meta">
        ${(entry.singers?.join(' · ') || entry.singer) ? `👤 ${escHtml(entry.singers?.join(' · ') || entry.singer)}` : ''}
        ${(entry.singers?.length || entry.singer) && pitchDisplay ? ' · ' : ''}
        ${pitchDisplay ? `🎵 ${escHtml(pitchDisplay)}` : ''}
      </div>
      ${lyrics ? `<div class="now-singing-lyrics">${escHtml(lyrics)}</div>` : ''}
    </div>`;
  }

  _sessionBhajansHTML(bhajans, isHost = false, phase = 'setup') {
    if (!bhajans.length) return '<div class="empty-state" style="padding:1.5rem 0"><p class="text-muted">No bhajans added yet</p></div>';

    const isPlaying = phase === 'playing';
    const currentId = this.liveState?.currentBhajan;

    return bhajans.map((e, i) => {
      const isCurrent = isPlaying && e.id === currentId;
      const canGoEarlier = i > 0;
      const canGoLater   = i < bhajans.length - 1;
      const eScale = this.bhajans.getById(e.bhajan_id)?.scale || '';

      if (isCurrent) {
        const bhajanRec = this.bhajans.getById(e.bhajan_id);
        const lyrics = bhajanRec?.lyrics || '';
        const pitchIndian  = e.pitch_indian  || e.pitch?.split(' / ')[0] || '';
        const pitchWestern = e.pitch_western || e.pitch?.split(' / ')[1] || '';
        return `
        <div class="session-bhajan-entry session-entry-current session-entry-playing">
          <div class="playing-entry-header">
            <span class="entry-num entry-num-playing">▶</span>
            <div class="entry-main">
              <div class="entry-title entry-title-link" data-bhajan-id="${e.bhajan_id}" data-entry-idx="${i}">${escHtml(e.bhajan_title)}</div>
              ${e.notes ? `<div class="entry-meta"><em>${escHtml(e.notes)}</em></div>` : ''}
            </div>
            ${isHost ? `<div class="playing-nav-btns">
              <button class="btn btn-nav-compact" id="btn-prev-bhajan" ${canGoEarlier ? '' : 'disabled'} title="Previous">‹</button>
              <button class="btn btn-nav-compact" id="btn-next-bhajan" title="Next">›</button>
            </div>` : ''}
          </div>
          ${(e.singers?.length || e.singer) ? `<div class="playing-singer-display">
            <span class="playing-singer-pill">👤 ${escHtml(e.singers?.join(' · ') || e.singer)}</span>
          </div>` : ''}
          ${e.pitch ? `<div class="playing-pitch-display">
            <span class="playing-pitch-indian">${escHtml(pitchIndian)}</span>
            ${pitchWestern ? `<span class="playing-pitch-sep">•</span><span class="playing-pitch-western">${escHtml(pitchWestern)}</span>` : ''}
            ${eScale ? `<span class="playing-pitch-scale">${escHtml(eScale)}</span>` : ''}
          </div>` : ''}
          ${lyrics ? `<div class="playing-entry-lyrics">${escHtml(lyrics)}</div>` : ''}
        </div>`;
      }

      const pitchIndian  = e.pitch_indian  || e.pitch?.split(' / ')[0] || '';
      const pitchWestern = e.pitch_western || e.pitch?.split(' / ')[1] || '';
      return `
      <div class="session-bhajan-entry" data-entry-id="${e.id}">
        ${!isPlaying ? `<div class="drag-handle" title="Hold and drag to reorder">⠿</div>` : ''}
        <div class="entry-num">${i + 1}</div>
        <div class="entry-main">
          <div class="entry-title entry-title-link" data-bhajan-id="${e.bhajan_id}" data-entry-idx="${i}">${escHtml(e.bhajan_title)}</div>
          ${(e.singers?.length || e.singer) ? `<div class="entry-singer-row">
            <span class="entry-singer-chip">👤 ${escHtml(e.singers?.join(' · ') || e.singer)}</span>
            ${!isPlaying ? `<span class="notes-editable entry-notes-inline" data-entry-id="${e.id}" data-mode="live" title="Edit notes">${e.notes ? `<em>${escHtml(e.notes)}</em>` : '+ notes'}</span>` : (e.notes ? `<em class="entry-notes-inline">${escHtml(e.notes)}</em>` : '')}
          </div>` : (e.notes || !isPlaying ? `<div class="entry-meta">
            ${!isPlaying ? `<span class="notes-editable" data-entry-id="${e.id}" data-mode="live" title="Edit notes">${e.notes ? `<em>${escHtml(e.notes)}</em>` : '<span class="pitch-unset">+ notes</span>'}</span>` : (e.notes ? `<em>${escHtml(e.notes)}</em>` : '')}
          </div>` : '')}
          <div class="entry-pitch-row">
            <span class="${!isPlaying ? 'pitch-editable' : ''}" data-entry-id="${e.id}" data-mode="live" title="${!isPlaying ? 'Tap to edit pitch' : ''}">
              ${e.pitch
                ? `<span class="pitch-badge pitch-gents session-pitch-badge">${escHtml(pitchIndian)}${pitchWestern ? `<span class="pitch-sep"> •</span><span class="pitch-western-bold"> ${escHtml(pitchWestern)}</span>` : ''}${eScale ? `<span class="pitch-scale"> ${escHtml(eScale)}</span>` : ''}</span>`
                : (!isPlaying ? `<span class="pitch-unset">+ pitch</span>` : '')}
            </span>
          </div>
        </div>
        <div class="entry-time">${formatTime(e.addedAt)}</div>
        ${!isPlaying ? `
        <div class="entry-actions">
          <button class="btn entry-action-btn" data-action="remove" data-entry-id="${e.id}" title="Remove">✕</button>
        </div>` : ''}
      </div>`;
    }).join('');
  }

  // ─── New Session Modal ────────────────────────────────────────────────────

  _sfIsBackdated = false;
  _pendingDeleteSeries = null;

  _openNewSession(backdated = false) {
    this._sfIsBackdated = backdated;

    document.getElementById('sf-date').value = todayISO();
    document.getElementById('sf-time-group').style.display = backdated ? '' : 'none';
    document.getElementById('sf-backdated-note').style.display = backdated ? '' : 'none';

    const series = this._selectedSeries;
    const display = document.getElementById('sf-series-display');
    if (display) display.textContent = series || '(no series selected)';

    document.getElementById('btn-mform-submit').textContent = backdated ? 'Add Session' : 'Start Session';
    document.getElementById('mform-title').textContent = backdated ? 'Add Past Session' : 'New Session';

    this._openModal('modal-session-form');
    setTimeout(() => document.getElementById('sf-date').focus(), 100);
  }

  _submitSessionForm() {
    const series    = this._selectedSeries;
    const date      = document.getElementById('sf-date').value;
    const backdated = this._sfIsBackdated;

    if (!date) { this._toast('Please set a date', 'error'); return; }
    if (!series) { this._toast('Please enter a series name', 'error'); return; }

    // Derive deterministic ID and room code from series + date
    const roomCode  = this._sessionRoomCode(series, date);
    const sessionId = roomCode;

    // Prevent duplicate
    if (this.sessions.get(sessionId)) {
      this._closeModal('modal-session-form');
      this._toast('A session for this series on this date already exists', 'warn');
      location.hash = `#session-detail/${sessionId}`;
      return;
    }

    const sessionData = {
      id: sessionId,
      label: series,
      series,
      date,
      roomCode,
      singers: [],
      bhajans: [],
      status: backdated ? 'completed' : 'live',
      isBackdated: backdated,
      createdAt: new Date().toISOString(),
      startTime: document.getElementById('sf-start-time').value || null,
      duration: null,
    };

    this._closeModal('modal-session-form');

    if (backdated) {
      this._openBackdatedEntry(sessionData);
    } else {
      this._startLiveSession(sessionData);
    }
  }

  // ─── Start Live Session ───────────────────────────────────────────────────

  _startLiveSession(sessionData) {
    this.live = new LiveSession({
      onStateChange: (state) => {
        this.liveState = state;
        this._onLiveStateChange();
      },
      onPeerChange: (count) => {
        const el = document.getElementById('live-observer-count');
        if (el) el.textContent = `${count} observer${count !== 1 ? 's' : ''}`;
      },
      onError: (msg) => this._toast(msg, 'error'),
    });

    const code = this.live.host(sessionData, sessionData.roomCode || null);
    sessionData.roomCode = code;
    sessionData.phase = 'setup';

    this.liveState = { ...sessionData };
    this.sessions.saveDraft(this.liveState);

    location.hash = '#session';
    this._renderSession();
    this._toast('Session started! Add bhajans then tap ▶ Start.', 'success');
  }

  _startPlaying() {
    const bhajans = this.liveState?.bhajans || [];
    if (!bhajans.length) {
      this._toast('Add at least one bhajan before starting', 'warn');
      return;
    }
    const today = _localDate(new Date());
    const updated = { ...this.liveState, phase: 'playing', currentBhajan: bhajans[0].id, startedAt: new Date().toISOString(), date: today };
    this.liveState = updated;
    this.live.updateState(updated);
    this.sessions.saveDraft(updated);
    this._renderSession();
  }

  _nextBhajan() {
    const bhajans = this.liveState?.bhajans || [];
    const currentIdx = bhajans.findIndex(e => e.id === this.liveState?.currentBhajan);
    const nextIdx = currentIdx + 1;
    if (nextIdx >= bhajans.length) {
      this._confirmEndSession();
    } else {
      const updated = { ...this.liveState, currentBhajan: bhajans[nextIdx].id };
      this.liveState = updated;
      this.live.updateState(updated);
      this.sessions.saveDraft(updated);
      this._renderSession();
      setTimeout(() => document.querySelector('.session-entry-current')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
    }
  }

  _prevBhajan() {
    const bhajans = this.liveState?.bhajans || [];
    const currentIdx = bhajans.findIndex(e => e.id === this.liveState?.currentBhajan);
    if (currentIdx <= 0) return;
    const updated = { ...this.liveState, currentBhajan: bhajans[currentIdx - 1].id };
    this.liveState = updated;
    this.live.updateState(updated);
    this.sessions.saveDraft(updated);
    this._renderSession();
    setTimeout(() => document.querySelector('.session-entry-current')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  _exitPlay() {
    const updated = { ...this.liveState, phase: 'setup' };
    this.liveState = updated;
    this.live.updateState(updated);
    this.sessions.saveDraft(updated);
    this._renderSession();
  }

  _resumeDraftSession(draft) {
    const sessionData = { ...draft, status: 'live' };
    const savedPhase = sessionData.phase; // preserve playing/setup phase
    this._startLiveSession(sessionData);
    // _startLiveSession resets phase to 'setup'; restore the saved phase
    if (savedPhase && savedPhase !== 'setup') {
      this.liveState = { ...this.liveState, phase: savedPhase };
      this.live.updateState(this.liveState);
      this.sessions.saveDraft(this.liveState);
      this._renderSession();
    }
    this._toast('Session resumed', 'success');
  }

  _onLiveStateChange() {
    // If session view is active, re-render live portion
    if (document.getElementById('view-session').classList.contains('active')) {
      const el = document.getElementById('session-content');
      if (this.liveState) this._renderLiveSession(el);
    }
    // Update draft
    if (this.live?.isHost && this.liveState) {
      this.sessions.saveDraft(this.liveState);
    }
  }

  // ─── Join Session ─────────────────────────────────────────────────────────

  async _openJoinModal() {
    const select = document.getElementById('mjoin-series');
    const errEl  = document.getElementById('mjoin-fetch-error');
    select.innerHTML = '<option value="" disabled selected>Loading…</option>';
    errEl.style.display = 'none';
    document.getElementById('mjoin-date').value = todayISO();

    this._openModal('modal-join-session');
    setTimeout(() => select.focus(), 100);

    const series = await this._fetchKnownSeries();
    if (!series.length) {
      errEl.textContent = 'No series found yet. Ask the host for the session code.';
      errEl.style.display = '';
      select.innerHTML = '<option value="" disabled selected>No series available</option>';
    } else {
      this._populateSeriesSelect(select, series, false);
      errEl.style.display = 'none';
    }
  }

  _joinSession() {
    const series = document.getElementById('mjoin-series').value;
    const date   = document.getElementById('mjoin-date').value;

    if (!series) { this._toast('Please select a series', 'error'); return; }
    if (!date)   { this._toast('Please select a date', 'error'); return; }

    const code = this._sessionRoomCode(series, date);
    this._closeModal('modal-join-session');
    this._joinSessionWithCode(code);
  }

  async _joinSessionWithCode(code) {
    // Guard against double-tap: leave any existing connection first
    if (this.live) { this.live.leave(); this.live = null; }

    const el = document.getElementById('session-content');
    el.innerHTML = `<div class="connecting-state">
      <div class="connecting-spinner"></div>
      <p>Connecting to session <strong>${escHtml(code)}</strong>…</p>
    </div>`;
    location.hash = '#session';

    const _exitObserver = () => {
      this.live = null;
      this.liveState = null;
      el.innerHTML = this._sessionHomeHTML(this.sessions.getDraft());
      this._bindSessionHome(this.sessions.getDraft());
    };

    this.live = new LiveSession({
      onStateChange: (state) => {
        if (state?.phase === 'ended') {
          this._toast('The bhajan session has ended.', 'info');
          _exitObserver();
          return;
        }
        this.liveState = state;
        if (document.getElementById('view-session').classList.contains('active')) {
          this._renderLiveSession(el);
        }
      },
      onPeerChange: () => {},
      onError: (msg) => this._toast(msg, 'error'),
      onHostLeave: () => {
        this._toast('The host has disconnected.', 'warn');
        _exitObserver();
      },
    });

    try {
      await this.live.join(code);
    } catch (err) {
      this._toast(err.message, 'error');
      this.live?.leave();
      this.live = null;
      el.innerHTML = this._sessionHomeHTML(this.sessions.getDraft());
      this._bindSessionHome(this.sessions.getDraft());
    }
  }

  // ─── Add Bhajan Modal ─────────────────────────────────────────────────────

  _openAddBhajanModal(preselect = null) {
    this._mabSelected = preselect || null;
    this._mabStep = preselect ? 2 : 1;

    document.getElementById('mab-search').value = '';
    document.getElementById('mab-notes').value = '';
    document.getElementById('mab-pitch').value = '';
    document.getElementById('mab-pitch-indian').value = '';
    document.getElementById('mab-pitch-western').value = '';
    document.getElementById('mab-pitch-hint').textContent = '';

    // Populate singer autocomplete: session bhajan singers first, then all historical
    this._mabSingers = [];
    this._mabRenderSingerChips();
    const sessionSingers = new Set((this.liveState?.bhajans || []).flatMap(e => e.singers || (e.singer ? [e.singer] : [])));
    const allSingers = this.sessions.allSingerNames?.() || [];
    // Deduplicate by canonical name, prefer canonical form in suggestions
    const seenCanon = new Set();
    const suggestions = [];
    for (const n of [...sessionSingers, ...allSingers.filter(n => !sessionSingers.has(n))]) {
      const canon = this._canonName(n);
      if (!seenCanon.has(canon)) { seenCanon.add(canon); suggestions.push(canon); }
    }
    this._mabSuggestions = suggestions.slice(0, 10);
    document.getElementById('mab-singer-list').innerHTML =
      suggestions.map(s => `<option value="${escHtml(s)}">`).join('');

    // Quick-select suggestion chips
    const suggEl = document.getElementById('mab-singer-suggestions');
    if (suggEl) {
      suggEl.innerHTML = this._mabSuggestions.map(n =>
        `<button type="button" class="singer-sugg-chip" data-name="${escHtml(n)}">${escHtml(n)}</button>`
      ).join('');
      suggEl.querySelectorAll('.singer-sugg-chip').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.name;
          if (!this._mabSingers.includes(name)) {
            this._mabSingers.push(name);
            this._mabRenderSingerChips();
            this._mabUpdatePitchHint();
          }
          this._mabUpdateSuggChips();
        });
      });
    }

    if (preselect) {
      this._mabShowStep2(preselect);
    } else {
      this._mabGoStep(1);
      this._mabSearch('');
    }

    this._openModal('modal-add-bhajan');
    if (!preselect) setTimeout(() => document.getElementById('mab-search').focus(), 100);
  }

  _mabGoStep(step) {
    this._mabStep = step;
    const s1 = document.getElementById('mab-step-search');
    const s2 = document.getElementById('mab-step-details');
    const backBtn = document.getElementById('btn-mab-back');
    const addBtn  = document.getElementById('btn-mab-add');

    if (step === 1) {
      s1.classList.remove('hidden');
      s2.classList.add('hidden');
      backBtn.classList.add('hidden');
      addBtn.classList.add('hidden');
      this._mabSelected = null;
    } else {
      s1.classList.add('hidden');
      s2.classList.remove('hidden');
      backBtn.classList.remove('hidden');
      addBtn.classList.remove('hidden');
    }
  }

  _mabSearch(q) {
    const query = q !== undefined ? q : document.getElementById('mab-search').value;
    const results = this.bhajans.search(query).slice(0, 50);
    const el = document.getElementById('mab-search-results');
    if (!results.length) {
      el.innerHTML = `<div class="empty-state" style="padding:1rem 0"><p class="text-muted">No results</p></div>`;
      return;
    }
    el.innerHTML = results.map(b => this._bhajanItemHTML(b)).join('');
    el.querySelectorAll('.bhajan-item').forEach(item => {
      item.addEventListener('click', () => {
        const b = this.bhajans.getById(item.dataset.id);
        if (b) this._mabShowStep2(b);
      });
    });
  }

  _mabShowStep2(b) {
    this._mabSelected = b;
    this._mabGoStep(2);

    document.getElementById('mab-selected-info').innerHTML = `
      <div class="mab-sel-title">${escHtml(b.title)}</div>
      <div class="mab-sel-meta">${escHtml([b.deity, b.language, b.tempo].filter(Boolean).join(' · '))}</div>`;

    // Set pitch buttons labels (show Indian · Western · Scale)
    const scaleSuffix = b.scale ? ` · ${b.scale}` : '';
    const gpLabel = b.gents_pitch_indian
      ? `${b.gents_pitch_indian} · ${b.gents_pitch_western}${scaleSuffix}`
      : (b.gents_pitch ? b.gents_pitch.split('/')[0].trim() : '');
    const lpLabel = b.ladies_pitch_indian
      ? `${b.ladies_pitch_indian} · ${b.ladies_pitch_western}${scaleSuffix}`
      : (b.ladies_pitch ? b.ladies_pitch.split('/')[0].trim() : '');
    document.getElementById('btn-pitch-gents').textContent = gpLabel ? `♂ ${gpLabel}` : 'Gents';
    document.getElementById('btn-pitch-ladies').textContent = lpLabel ? `♀ ${lpLabel}` : 'Ladies';
    document.getElementById('btn-pitch-gents').style.display = b.gents_pitch ? '' : 'none';
    document.getElementById('btn-pitch-ladies').style.display = b.ladies_pitch ? '' : 'none';

    this._mabUpdatePitchHint();
  }

  // Set all three pitch fields (combined, Indian, Western) from a combined string
  _setMabPitch(combined) {
    const p = pitchByCombined(combined);
    document.getElementById('mab-pitch').value         = p?.combined || combined || '';
    document.getElementById('mab-pitch-indian').value  = p?.indian   || combined.split(' / ')[0]?.trim() || '';
    document.getElementById('mab-pitch-western').value = p?.western  || combined.split(' / ')[1]?.trim() || '';
  }

  _mabAddSingerFromInput() {
    const inp = document.getElementById('mab-singer');
    const name = inp.value.trim();
    if (name && !this._mabSingers.includes(name)) {
      this._mabSingers.push(name);
      this._mabRenderSingerChips();
      this._mabUpdatePitchHint();
      this._mabUpdateSuggChips();
    }
    inp.value = '';
    inp.focus();
  }

  _mabRenderSingerChips() {
    const box = document.getElementById('mab-singers-box');
    const inp = document.getElementById('mab-singer');
    if (!box || !inp) return;
    box.querySelectorAll('.singer-chip-sm').forEach(c => c.remove());
    for (const name of this._mabSingers) {
      const chip = document.createElement('span');
      chip.className = 'singer-chip-sm';
      chip.innerHTML = `${escHtml(name)}<button type="button" class="chip-x" aria-label="Remove ${escHtml(name)}">×</button>`;
      chip.querySelector('.chip-x').addEventListener('click', () => {
        this._mabSingers = this._mabSingers.filter(n => n !== name);
        this._mabRenderSingerChips();
        this._mabUpdatePitchHint();
        this._mabUpdateSuggChips();
      });
      box.insertBefore(chip, inp);
    }
    inp.placeholder = this._mabSingers.length ? 'Add another…' : 'Add singer…';
  }

  _mabUpdateSuggChips() {
    document.querySelectorAll('#mab-singer-suggestions .singer-sugg-chip').forEach(btn => {
      btn.classList.toggle('hidden', this._mabSingers.includes(btn.dataset.name));
    });
  }

  _mabUpdatePitchHint() {
    const singer = this._mabSingers[0] || null;
    const b = this._mabSelected;
    const hintEl   = document.getElementById('mab-pitch-hint');
    const combined = document.getElementById('mab-pitch').value;

    if (singer && b) {
      const prevPitch = this.sessions.singerBhajanPitch(singer, b.id);
      if (prevPitch) {
        this._setMabPitch(prevPitch);
        hintEl.textContent = `↺ ${singer} sang this at ${prevPitch} before`;
        return;
      }
      const usual = this.sessions.singerUsualPitch(singer);
      if (usual) {
        hintEl.textContent = `💡 ${singer}'s usual pitch: ${usual}`;
        if (!combined) this._setMabPitch(usual);
        return;
      }
    }
    hintEl.textContent = '';
    if (!combined && b?.gents_pitch) this._setMabPitch(b.gents_pitch);
  }

  _mabConfirmAdd() {
    const b = this._mabSelected;
    if (!b) return;

    // Flush any name still typed but not yet chip-added
    const typedName = document.getElementById('mab-singer').value.trim();
    if (typedName && !this._mabSingers.includes(typedName)) this._mabSingers.push(typedName);

    const singers = this._mabSingers.length ? [...this._mabSingers] : null;
    const pitch  = document.getElementById('mab-pitch').value.trim();
    const notes  = document.getElementById('mab-notes').value.trim();
    const { pitch_indian, pitch_western } = splitPitchCombined(pitch);

    const entry = {
      id: genId('e'),
      bhajan_id:    b.id,
      bhajan_title: b.title,
      bhajan_deity: b.deity,
      singers:       singers,
      pitch:         pitch || null,
      pitch_indian:  pitch_indian || null,
      pitch_western: pitch_western || null,
      notes:         notes || null,
      addedAt:       Date.now(),
    };

    const updated = {
      ...this.liveState,
      bhajans: [...(this.liveState.bhajans || []), entry],
    };

    this._applyLiveEdit(updated, { type: 'add-bhajan', entry });
    this._closeModal('modal-add-bhajan');
    this._renderSession();
    this._toast(`Added: ${b.title}`, 'success');
  }

  // ─── Live edit helper ─────────────────────────────────────────────────────

  _applyLiveEdit(updatedState, action) {
    this.liveState = updatedState;
    if (this.live?.isHost) {
      this.live.updateState(updatedState);
      this.sessions.saveDraft(updatedState);
    } else {
      this.live?.sendAction(action);
    }
  }

  // ─── Remove / set current bhajan ─────────────────────────────────────────

  _removeBhajanEntry(entryId) {
    const updated = {
      ...this.liveState,
      bhajans: (this.liveState.bhajans || []).filter(e => e.id !== entryId),
      currentBhajan: this.liveState.currentBhajan === entryId ? null : this.liveState.currentBhajan,
    };
    this._applyLiveEdit(updated, { type: 'remove-bhajan', entryId });
    this._renderSession();
  }


  // ─── End / Discard Session ────────────────────────────────────────────────

  _confirmEndSession() {
    const bhCount = (this.liveState?.bhajans || []).length;
    if (!confirm(`End session? ${bhCount} bhajans will be saved.`)) return;
    this._endSession();
  }

  _discardSession() {
    const label = this.liveState?.label || 'this session';
    if (!confirm(`Discard "${label}"? Nothing will be saved.`)) return;

    this.sessions.clearDraft();
    this.live?.leave();
    this.live = null;
    this.liveState = null;

    document.getElementById('bnav-session-icon').classList.remove('is-live');
    location.hash = '#dashboard';
    this._toast('Session discarded');
  }

  _endSession() {
    const startTs = this.liveState.startedAt || this.liveState.createdAt;
    const started = startTs ? new Date(startTs) : null;
    const duration = started ? Math.round((Date.now() - started.getTime()) / 1000) : null;

    const singers = [...new Set((this.liveState.bhajans || []).flatMap(e => e.singers || (e.singer ? [e.singer] : [])))];

    const finalSession = {
      ...this.liveState,
      singers,
      status: 'completed',
      endedAt: new Date().toISOString(),
      duration,
    };

    this.sessions.save(finalSession);
    this.sessions.commitNow?.('End bhajan session');
    this.sessions.clearDraft();

    this.live?.end(); // broadcasts 'ended' to observers before leaving
    this.live = null;
    this.liveState = null;

    document.getElementById('bnav-session-icon').classList.remove('is-live');

    this._renderSessionEndSummary(finalSession);
  }

  _renderSessionEndSummary(s) {
    const el = document.getElementById('session-content');
    el.innerHTML = `
      <div class="session-end-card">
        <div class="session-end-icon">🙏</div>
        <div class="session-end-title">${escHtml(s.label || 'Bhajan Session')} Completed</div>
        <div class="text-muted text-small">${formatDate(s.date)}</div>
        <div class="session-end-stats">
          <div><div class="end-stat-num">${(s.bhajans || []).length}</div><div class="end-stat-label">Bhajans</div></div>
          ${s.singers?.length ? `<div><div class="end-stat-num">${s.singers.length}</div><div class="end-stat-label">Singers</div></div>` : ''}
          ${s.duration ? `<div><div class="end-stat-num">${this._formatDuration(s.duration)}</div><div class="end-stat-label">Duration</div></div>` : ''}
        </div>
        <button class="btn btn-primary" onclick="location.hash='#session-detail/${s.id}'">View Session →</button>
      </div>`;
  }

  // ─── Backdated Session ────────────────────────────────────────────────────

  _openBackdatedEntry(sessionData) {
    // Open session detail directly in "edit" mode so user can add bhajans
    // We save the session immediately and open its detail
    this.sessions.save(sessionData, { local: true });
    location.hash = `#session-detail/${sessionData.id}`;
    this._toast('Session created. Add bhajans below.', 'success');
  }

  // ─── History ──────────────────────────────────────────────────────────────

  _renderHistory() {
    const all = this.sessions.activeAll();
    const el  = document.getElementById('history-list');

    if (!all.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">📅</div>
        <p>No sessions recorded yet.</p></div>`;
      return;
    }

    // Group by month
    const byMonth = {};
    for (const s of all) {
      const m = monthLabel(s.date);
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(s);
    }

    el.innerHTML = Object.entries(byMonth).map(([month, sessions]) => `
      <div class="history-month">${month}</div>
      ${sessions.map(s => this._sessionCardHTML(s)).join('')}
    `).join('');

    el.querySelectorAll('.session-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        location.hash = `#session-detail/${card.dataset.id}`;
      });
    });
  }

  // ─── Inline pitch edit ───────────────────────────────────────────────────

  _pitchIndianOptionsHTML(current = '') {
    const mk = (p) => `<option${p.indian === current ? ' selected' : ''}>${escHtml(p.indian)}</option>`;
    const pancham = PITCH_OPTIONS.filter(p => p.series === 'Pancham').map(mk).join('');
    const madhyam = PITCH_OPTIONS.filter(p => p.series === 'Madhyam').map(mk).join('');
    return `<option value="">Indian…</option><optgroup label="Pancham">${pancham}</optgroup><optgroup label="Madhyam">${madhyam}</optgroup>`;
  }

  _pitchWesternOptionsHTML(current = '') {
    const notes = ['C','C#','D','E','F','F#','G','G#','A','A#','B'];
    return `<option value="">Western…</option>` +
      notes.map(n => `<option${n === current ? ' selected' : ''}>${escHtml(n)}</option>`).join('');
  }

  _inlinePitchEdit(triggerEl, entryId, mode) {
    const entries = mode === 'live'
      ? (this.liveState?.bhajans || [])
      : (this.sessions.get(this._detailSessionId)?.bhajans || []);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    const currentP = pitchByCombined(entry.pitch || '') || null;

    const container = document.createElement('div');
    container.className = 'pitch-inline-dual';

    const indianSel = document.createElement('select');
    indianSel.className = 'pitch-inline-select form-input';
    indianSel.innerHTML = this._pitchIndianOptionsHTML(currentP?.indian || '');

    const westernSel = document.createElement('select');
    westernSel.className = 'pitch-inline-select form-input';
    westernSel.innerHTML = this._pitchWesternOptionsHTML(currentP?.western || '');

    container.append(indianSel, westernSel);
    triggerEl.replaceWith(container);
    indianSel.focus();

    const save = () => {
      const p = pitchByIndian(indianSel.value);
      const newPitch   = p?.combined || null;
      const newIndian  = p?.indian   || null;
      const newWestern = p?.western  || null;
      if (mode === 'live') {
        const updated = {
          ...this.liveState,
          bhajans: (this.liveState.bhajans || []).map(e =>
            e.id === entryId ? { ...e, pitch: newPitch, pitch_indian: newIndian, pitch_western: newWestern } : e),
        };
        this._applyLiveEdit(updated, { type: 'update-pitch', entryId, pitch: newPitch, pitch_indian: newIndian, pitch_western: newWestern });
        this._renderSession();
      } else {
        const session = this.sessions.get(this._detailSessionId);
        if (!session) return;
        const updated = {
          ...session,
          bhajans: session.bhajans.map(e =>
            e.id === entryId ? { ...e, pitch: newPitch, pitch_indian: newIndian, pitch_western: newWestern } : e),
        };
        this.sessions.save(updated, { local: true });
        this._renderSessionDetail(this._detailSessionId);
      }
    };

    // Indian → auto-set Western → save
    indianSel.addEventListener('change', () => {
      const p = pitchByIndian(indianSel.value);
      westernSel.value = p?.western || '';
      save();
    });

    // Western → keep current series → auto-set Indian → save
    westernSel.addEventListener('change', () => {
      const series = pitchByIndian(indianSel.value)?.series || 'Pancham';
      const p = pitchByWestern(westernSel.value, series);
      if (p) { indianSel.value = p.indian; save(); }
    });

    // Escape: cancel without saving
    container.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') container.replaceWith(triggerEl);
    });

    // Blur away from the whole container: cancel
    container.addEventListener('focusout', () => {
      setTimeout(() => { if (!container.contains(document.activeElement)) container.replaceWith(triggerEl); }, 0);
    });
  }

  // ─── Inline notes edit ────────────────────────────────────────────────────

  _inlineNotesEdit(triggerEl, entryId, mode) {
    const entries = mode === 'live'
      ? (this.liveState?.bhajans || [])
      : (this.sessions.get(this._detailSessionId)?.bhajans || []);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'notes-inline-input form-input';
    inp.value = entry.notes || '';
    inp.placeholder = 'Add notes…';

    triggerEl.replaceWith(inp);
    inp.focus();
    inp.select();

    const save = () => {
      const newNotes = inp.value.trim() || null;
      if (mode === 'live') {
        const updated = {
          ...this.liveState,
          bhajans: (this.liveState.bhajans || []).map(e =>
            e.id === entryId ? { ...e, notes: newNotes } : e),
        };
        this._applyLiveEdit(updated, { type: 'update-notes', entryId, notes: newNotes });
        this._renderSession();
      } else {
        const session = this.sessions.get(this._detailSessionId);
        if (!session) return;
        const updated = {
          ...session,
          bhajans: session.bhajans.map(e =>
            e.id === entryId ? { ...e, notes: newNotes } : e),
        };
        this.sessions.save(updated, { local: true });
        this._renderSessionDetail(this._detailSessionId);
      }
    };

    let done = false;
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter')  { done = true; inp.blur(); }
      if (ev.key === 'Escape') { done = true; inp.replaceWith(triggerEl); }
    });
    inp.addEventListener('blur', () => { if (!done) { done = true; save(); } });
  }

  // ─── Session Detail ───────────────────────────────────────────────────────

  _renderSessionDetail(id) {
    this._detailSessionId = id;
    const s = this.sessions.get(id);
    if (!s) {
      document.getElementById('session-detail-content').innerHTML =
        `<div class="empty-state"><p>Session not found</p></div>`;
      return;
    }

    const canEdit = s.status === 'completed' || s.isBackdated;
    const hasPat  = !!GitHubStore.getPat();

    document.getElementById('session-detail-content').innerHTML = `
      <div class="session-detail-header">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem">
          <div>
            <div class="session-detail-title">${escHtml(s.label || 'Bhajan Session')}</div>
            <div class="session-detail-date">${formatDate(s.date)}${s.isBackdated ? ' · Backdated' : ''}</div>
          </div>
          <div style="display:flex;gap:.4rem;flex-shrink:0">
            ${canEdit && hasPat ? `<button class="btn btn-outline btn-sm" id="btn-detail-save">↑ Save</button>` : ''}
            ${canEdit ? `<button class="btn btn-outline btn-sm" id="btn-detail-add-bhajan">+ Bhajan</button>` : ''}
            <button class="btn btn-danger btn-sm" id="btn-detail-delete">Delete</button>
          </div>
        </div>
        <div class="session-detail-stats">
          <span>🎵 ${(s.bhajans || []).length} bhajans</span>
          ${s.duration ? `<span>⏱ ${this._formatDuration(s.duration)}</span>` : ''}
        </div>
        ${s.singers?.length ? `
          <div class="session-singers-row">
            ${s.singers.map(name => `<span class="singer-chip clickable" data-singer="${escHtml(name)}">
              <span class="singer-avatar">${escHtml(name[0]?.toUpperCase() || '?')}</span>
              ${escHtml(name)}</span>`).join('')}
          </div>` : ''}
      </div>

      ${(s.bhajans || []).length
        ? `<div class="session-bhajan-timeline">
            ${(s.bhajans).map((e, i) => {
              const eScale = this.bhajans.getById(e.bhajan_id)?.scale || '';
              return `
              <div class="timeline-item">
                <div class="tl-num">${i + 1}</div>
                <div class="tl-main">
                  <div class="tl-title tl-title-link" data-bhajan-id="${e.bhajan_id}" data-entry-idx="${i}">${escHtml(e.bhajan_title)}</div>
                  <div class="tl-meta">
                    ${(e.singers?.length || e.singer) ? `👤 ${escHtml(e.singers?.join(' · ') || e.singer)}` : ''}
                    ${(e.singers?.length || e.singer) ? ' · ' : ''}
                    <span class="${canEdit ? 'pitch-editable' : ''}" data-entry-id="${e.id}" data-mode="detail" title="${canEdit ? 'Edit pitch' : ''}">
                      ${e.pitch
                        ? `🎵 <span class="pitch-badge pitch-gents">${escHtml(e.pitch_indian || e.pitch.split(' / ')[0])}<span class="pitch-western"> ${escHtml(e.pitch_western || e.pitch.split(' / ')[1] || '')}</span>${eScale ? `<span class="pitch-scale"> ${escHtml(eScale)}</span>` : ''}</span>`
                        : (canEdit ? `<span class="pitch-unset">+ pitch</span>` : '')}
                    </span>
                  </div>
                  ${canEdit
                    ? `<div class="tl-notes notes-editable" data-entry-id="${e.id}" data-mode="detail" title="Edit notes">${e.notes ? escHtml(e.notes) : '<span class="pitch-unset">+ notes</span>'}</div>`
                    : (e.notes ? `<div class="tl-notes">${escHtml(e.notes)}</div>` : '')}
                </div>
                <div class="tl-actions">
                  <span class="tl-time">${formatTime(e.addedAt)}</span>
                  ${canEdit ? `
                  <div class="reorder-btns reorder-btns-row">
                    <button class="btn btn-reorder" data-action="reorder-earlier" data-entry-id="${e.id}" ${i > 0 ? '' : 'disabled'} title="Move up">↑</button>
                    <button class="btn btn-reorder" data-action="reorder-later" data-entry-id="${e.id}" ${i < (s.bhajans.length - 1) ? '' : 'disabled'} title="Move down">↓</button>
                  </div>
                  <button class="btn btn-ghost btn-sm entry-action-btn" data-action="remove" data-entry-id="${e.id}">✕</button>` : ''}
                </div>
              </div>`;
            }).join('')}
          </div>`
        : `<div class="empty-state"><p class="text-muted">No bhajans in this session${canEdit ? '. Use "+ Bhajan" to add.' : '.'}</p></div>`}
    `;

    // Bind singer clicks
    document.querySelectorAll('#session-detail-content .singer-chip.clickable').forEach(el => {
      el.addEventListener('click', () => { location.hash = `#singer/${encodeURIComponent(el.dataset.singer)}`; });
    });

    // Clickable bhajan titles → open modal with session context
    document.querySelectorAll('#session-detail-content .tl-title-link').forEach(el => {
      el.addEventListener('click', () => {
        const bhajanIds = (s.bhajans || []).map(e => e.bhajan_id);
        const idx = parseInt(el.dataset.entryIdx);
        this._openBhajanModal(el.dataset.bhajanId, { bhajans: bhajanIds, index: idx });
      });
    });

    // Add bhajan to completed/backdated session
    if (canEdit) {
      document.getElementById('btn-detail-save')?.addEventListener('click', () => {
        this.sessions.commitNow?.('Save session to GitHub');
        this._toast('Saving to GitHub…', 'success');
      });

      document.getElementById('btn-detail-add-bhajan')?.addEventListener('click', () => {
        this._openDetailAddBhajan(s);
      });

      // Reorder bhajans in session detail
      document.querySelectorAll('#session-detail-content .btn-reorder').forEach(btn => {
        btn.addEventListener('click', () => {
          const current = this.sessions.get(id);
          if (!current) return;
          const dir = btn.dataset.action === 'reorder-earlier' ? 'earlier' : 'later';
          const newBhajans = this._moveBhajanEntry(btn.dataset.entryId, dir, current.bhajans || []);
          this.sessions.save({ ...current, bhajans: newBhajans }, { local: true });
          this._renderSessionDetail(id);
        });
      });

      document.querySelectorAll('#session-detail-content .entry-action-btn[data-action="remove"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updated = { ...s, bhajans: (s.bhajans || []).filter(e => e.id !== btn.dataset.entryId) };
          this.sessions.save(updated, { local: true });
          this._renderSessionDetail(id);
        });
      });

      document.querySelectorAll('#session-detail-content .pitch-editable').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          this._inlinePitchEdit(el, el.dataset.entryId, 'detail');
        });
      });

      document.querySelectorAll('#session-detail-content .notes-editable').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          this._inlineNotesEdit(el, el.dataset.entryId, 'detail');
        });
      });
    }

    document.getElementById('btn-detail-delete').addEventListener('click', () => {
      if (confirm('Delete this session? This cannot be undone.')) {
        this.sessions.delete(id);
        location.hash = '#history';
        this._toast('Session deleted');
      }
    });
  }

  _openDetailAddBhajan(session) {
    // Temporarily set liveState for the add modal to work.
    // Store prevLive so we can restore on ANY close path (confirm, cancel, backdrop).
    const prevLive = this.liveState;
    const prevLiveConn = this.live;
    const origConfirm = this._mabConfirmAdd.bind(this);
    this.liveState = { ...session };
    this.live = null; // not actually live; prevents broadcasting via _applyLiveEdit

    // Restore on every close path via the _modalCleanup hook
    if (!this._modalCleanup) this._modalCleanup = {};
    this._modalCleanup['modal-add-bhajan'] = () => {
      this.liveState = prevLive;
      this.live = prevLiveConn;
      this._mabConfirmAdd = origConfirm;
    };

    this._openAddBhajanModal();

    // Override the confirm button to save to history instead of broadcasting
    this._mabConfirmAdd = () => {
      const b = this._mabSelected;
      if (!b) return;

      // Flush any name still typed but not yet chip-added
      const typedName = document.getElementById('mab-singer').value.trim();
      if (typedName && !this._mabSingers.includes(typedName)) this._mabSingers.push(typedName);

      const singers = this._mabSingers.length ? [...this._mabSingers] : null;
      const pitch  = document.getElementById('mab-pitch').value.trim();
      const notes  = document.getElementById('mab-notes').value.trim();
      const { pitch_indian, pitch_western } = splitPitchCombined(pitch);

      const entry = {
        id: genId('e'),
        bhajan_id:    b.id,
        bhajan_title: b.title,
        bhajan_deity: b.deity,
        singers:       singers,
        pitch:         pitch || null,
        pitch_indian:  pitch_indian || null,
        pitch_western: pitch_western || null,
        notes:         notes || null,
        addedAt:       Date.now(),
      };
      const newBhajans = [...(session.bhajans || []), entry];
      const sessionSingers = [...new Set(newBhajans.flatMap(e => e.singers || (e.singer ? [e.singer] : [])))];
      const updated = { ...session, bhajans: newBhajans, singers: sessionSingers };
      this.sessions.save(updated, { local: true });

      this._closeModal('modal-add-bhajan'); // cleanup hook restores liveState/live/origConfirm
      this._renderSessionDetail(session.id);
      this._toast(`Added: ${b.title}`, 'success');
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _periodFromDate(period) {
    if (!period || period === 'all') return null;
    const d = new Date();
    if (period === '1y') d.setFullYear(d.getFullYear() - 1);
    else if (period === '6m') d.setMonth(d.getMonth() - 6);
    else if (period === '3m') d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  }

  _singerHue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 37 + name.charCodeAt(i)) % 360;
    return h;
  }

  _deitySlug(deity) {
    if (!deity) return 'other';
    const d = deity.toLowerCase();
    if (d.includes('ganesha') || d.includes('ganesh') || d.includes('ganapati')) return 'ganesha';
    if (d.includes('shiva') || d.includes('siva') || d.includes('mahadeva')) return 'shiva';
    if (d.includes('vishnu') || d.includes('narayana') || d.includes('venkatesha')) return 'vishnu';
    if (d.includes('devi') || d.includes('durga') || d.includes('lakshmi') || d.includes('saraswati') || d.includes('parvati') || d.includes('shakti') || d.includes('amba')) return 'devi';
    if (d.includes('rama') || d.includes('ram')) return 'rama';
    if (d.includes('krishna') || d.includes('govinda') || d.includes('hari')) return 'krishna';
    if (d.includes('hanuman') || d.includes('anjaneya')) return 'hanuman';
    if (d.includes('subramanya') || d.includes('murugan') || d.includes('kartikeya')) return 'murugan';
    if (d.includes('ayyappa') || d.includes('sastha')) return 'ayyappa';
    return 'other';
  }

  // ─── Singers Directory ───────────────────────────────────────────────────

  _renderSingers() {
    const rawStats = this.sessions.allSingersWithStats();

    // Merge aliases into canonical names
    const canonMap = {};
    for (const s of rawStats) {
      const canon = this._canonName(s.name);
      if (!canonMap[canon]) {
        canonMap[canon] = { ...s, name: canon, _deityMerged: { ...s.deities }, _pitchMerged: { ...s.pitches } };
      } else {
        canonMap[canon].sessionCount += s.sessionCount;
        canonMap[canon].bhajanCount += s.bhajanCount;
        for (const [d, c] of Object.entries(s.deities)) {
          canonMap[canon]._deityMerged[d] = (canonMap[canon]._deityMerged[d] || 0) + c;
        }
        for (const [p, c] of Object.entries(s.pitches || {})) {
          canonMap[canon]._pitchMerged[p] = (canonMap[canon]._pitchMerged[p] || 0) + c;
        }
      }
    }

    const allSingers = Object.values(canonMap).map(s => ({
      ...s,
      topDeity: Object.entries(s._deityMerged).sort((a,b) => b[1]-a[1])[0]?.[0] || null,
      usualPitch: Object.entries(s._pitchMerged).sort((a,b) => b[1]-a[1])[0]?.[0] || null,
    })).sort((a, b) => b.bhajanCount - a.bhajanCount);

    document.getElementById('singers-count-badge').textContent = allSingers.length;

    if (!allSingers.length) {
      document.getElementById('singers-grid').innerHTML =
        `<div class="empty-state"><div class="empty-icon">🎤</div><p>No singers recorded yet.</p></div>`;
      return;
    }

    document.getElementById('singers-grid').innerHTML = allSingers.map(s => {
      const hue = this._singerHue(s.name);
      const initials = s.name.split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase() || '?';
      const deitySlug = this._deitySlug(s.topDeity);
      const pitchShort = s.usualPitch ? (s.usualPitch.split(' / ')[1] || s.usualPitch.split(' ')[0]) : null;
      return `<div class="singer-card" data-name="${escHtml(s.name)}">
        <div class="singer-card-avatar" style="background:hsl(${hue},55%,88%);color:hsl(${hue},55%,32%)">${initials}</div>
        <div class="singer-card-name">${escHtml(s.name)}</div>
        <div class="singer-card-stats">${s.sessionCount} session${s.sessionCount !== 1 ? 's' : ''} · ${s.bhajanCount} bhajans</div>
        ${s.topDeity ? `<div class="singer-card-deity"><span class="deity-pill deity-${deitySlug}">${escHtml(s.topDeity)}</span></div>` : ''}
        ${pitchShort ? `<div class="singer-card-pitch">${escHtml(pitchShort)}</div>` : ''}
      </div>`;
    }).join('');

    document.querySelectorAll('#singers-grid .singer-card').forEach(el => {
      el.addEventListener('click', () => {
        location.hash = `#singer/${encodeURIComponent(el.dataset.name)}`;
      });
    });
  }

  _renderSinger(name) {
    // Resolve to canonical name and load merged history (including aliases)
    const canonName = this._canonName(name);
    const aliases = this._allAliasesOf(canonName).filter(n => n !== canonName);
    const { sessions, bhajans, usualPitch, uniqueBhajans } = this._singerHistoryMerged(canonName);

    // Deity stats (merge across all alias names)
    const deityRaw = {};
    for (const n of this._allAliasesOf(canonName)) {
      for (const d of this.sessions.singerDeityStats(n)) {
        deityRaw[d.deity] = (deityRaw[d.deity] || 0) + d.count;
      }
    }
    const deityTotal = Object.values(deityRaw).reduce((a, b) => a + b, 0);
    const deityStats = Object.entries(deityRaw).sort((a, b) => b[1] - a[1])
      .map(([deity, count]) => ({ deity, count, pct: deityTotal ? Math.round(count / deityTotal * 100) : 0 }));

    // Co-singers (merge across alias names)
    const coRaw = {};
    for (const n of this._allAliasesOf(canonName)) {
      for (const c of this.sessions.coSingers(n)) {
        const cc = this._canonName(c.name);
        if (cc !== canonName) coRaw[cc] = (coRaw[cc] || 0) + c.count;
      }
    }
    const coSingers = Object.entries(coRaw).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([n, count]) => ({ name: n, count }));

    const hue = this._singerHue(canonName);
    const initials = canonName.split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase() || '?';
    const pitchShort = usualPitch ? (usualPitch.split(' / ')[1] || usualPitch.split(' ')[0]) : null;

    document.getElementById('singer-content').innerHTML = `
      <div class="singer-header">
        <div class="singer-big-avatar" style="background:hsl(${hue},55%,88%);color:hsl(${hue},55%,30%)">${initials}</div>
        <div class="singer-header-info">
          <div class="singer-info-name">${escHtml(canonName)}</div>
          ${aliases.length ? `<div class="singer-aliases">Also: ${aliases.map(a => escHtml(a)).join(', ')}</div>` : ''}
          <div class="singer-stats-row">
            <span class="singer-stat-pill">${sessions.length} session${sessions.length !== 1 ? 's' : ''}</span>
            <span class="singer-stat-pill">${bhajans.length} sung</span>
            ${pitchShort ? `<span class="singer-stat-pill pitch-pill">Key: ${escHtml(pitchShort)}</span>` : ''}
          </div>
        </div>
      </div>

      ${deityStats.length ? `
        <div class="section-header">
          <h3 class="section-title">Deity Affinity</h3>
        </div>
        <div class="deity-breakdown">
          ${deityStats.map(d => `
            <div class="deity-bar-row">
              <span class="deity-bar-label deity-${this._deitySlug(d.deity)}">${escHtml(d.deity)}</span>
              <div class="deity-bar-track">
                <div class="deity-bar-fill deity-fill-${this._deitySlug(d.deity)}" style="width:${d.pct}%"></div>
              </div>
              <span class="deity-bar-pct">${d.pct}%</span>
              <span class="deity-bar-count">${d.count}</span>
            </div>`).join('')}
        </div>` : ''}

      ${coSingers.length ? `
        <div class="section-header section-header-spaced">
          <h3 class="section-title">Often Sings With</h3>
        </div>
        <div class="co-singers-row">
          ${coSingers.map(c => {
            const ch = this._singerHue(c.name);
            return `<a href="#singer/${encodeURIComponent(c.name)}" class="co-singer-chip"
              style="background:hsl(${ch},50%,92%);color:hsl(${ch},50%,30%);border-color:hsl(${ch},40%,78%)">
              ${escHtml(c.name)}<span class="co-singer-count">${c.count}</span>
            </a>`;
          }).join('')}
        </div>` : ''}

      <div class="section-header section-header-spaced">
        <h3 class="section-title">Bhajans Sung</h3>
        <span class="section-count">${uniqueBhajans.length} unique</span>
      </div>

      ${uniqueBhajans.length
        ? `<div class="bhajan-list">
            ${uniqueBhajans.map(b => `
              <div class="singer-bhajan-item" data-bhajan-id="${b.id}">
                <div class="bhajan-item-main">
                  <div class="bhajan-item-title">${escHtml(b.title || b.id)}</div>
                  ${b.lastPitch ? `<div class="bhajan-item-meta">Last key: ${escHtml(b.lastPitch.split(' / ')[1] || b.lastPitch)}</div>` : ''}
                </div>
                <span class="singer-bhajan-count">${b.count}×</span>
              </div>`).join('')}
          </div>`
        : `<div class="empty-state"><p class="text-muted">No bhajans recorded for ${escHtml(name)} yet</p></div>`}

      ${sessions.length ? `
        <div class="section-header section-header-spaced">
          <h3 class="section-title">Sessions</h3>
        </div>
        ${sessions.slice(0, 10).map(s => this._sessionCardHTML(s)).join('')}` : ''}
    `;

    // Bhajan click → detail modal
    document.querySelectorAll('#singer-content .singer-bhajan-item').forEach(el => {
      el.addEventListener('click', () => this._openBhajanModal(el.dataset.bhajanId));
    });
    document.querySelectorAll('#singer-content .session-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        location.hash = `#session-detail/${card.dataset.id}`;
      });
    });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => { window._app = new App(); });
