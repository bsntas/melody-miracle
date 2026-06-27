import { BhajanStore, SessionStore, genId, formatDate, formatTime, todayISO, monthLabel, escHtml } from './store.js';
import { GitHubStore } from './github-store.js';
import { LiveSession } from './live.js';

// ─── App ──────────────────────────────────────────────────────────────────────

class App {
  constructor() {
    this.bhajans   = new BhajanStore();
    this.sessions  = new SessionStore();  // replaced by GitHubStore if PAT set
    this.live      = null;  // LiveSession instance when active
    this.liveState = null;  // current live session state (host or observer)

    this._toastTimer = null;
    this._browseFiltered = [];
    this._mabSelected  = null; // bhajan selected in Add Bhajan modal
    this._mabStep      = 1;
    this._bhajanModalContext = null;

    this._init();
  }

  async _init() {
    try {
      await this.bhajans.load();
    } catch (e) {
      document.getElementById('loading-text').textContent = 'Failed to load. Please refresh.';
      return;
    }

    // Upgrade to GitHub-backed store if a PAT is saved
    const pat = GitHubStore.getPat();
    if (pat) {
      const ghStore = new GitHubStore(pat);
      ghStore.onSyncChange = (status, msg) => this._onSyncChange(status, msg);
      this.sessions = ghStore;
      // Load from GitHub (falls back to localStorage cache on failure)
      document.getElementById('loading-text').textContent = 'Syncing sessions…';
      await this.sessions.load();
    }

    this._populateFilters();
    this._bindGlobal();
    this._bindSettings();
    this._initKeyboardAdjust();
    this._hideLoading();
    this._updateSyncIndicator(pat ? this.sessions.syncStatus : 'local');
    this._route();
    window.addEventListener('hashchange', () => this._route());
  }

  _hideLoading() {
    document.getElementById('loading-screen').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  _route() {
    const hash = location.hash.slice(1) || 'dashboard';
    const [view, param] = hash.split('/');

    const views = ['dashboard', 'browse', 'session', 'history', 'singer', 'session-detail'];
    views.forEach(v => document.getElementById(`view-${v}`)?.classList.remove('active'));

    const viewEl = document.getElementById(`view-${view}`);
    if (viewEl) viewEl.classList.add('active');

    document.querySelectorAll('[data-view]').forEach(el => {
      el.classList.toggle('active', el.dataset.view === view);
    });

    switch (view) {
      case 'dashboard':     this._renderDashboard(); break;
      case 'browse':        this._renderBrowse(); break;
      case 'session':       this._renderSession(); break;
      case 'history':       this._renderHistory(); break;
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

  // ─── Global bindings ──────────────────────────────────────────────────────

  _bindGlobal() {
    // Dashboard
    document.getElementById('btn-dash-new-session').addEventListener('click', () => this._openNewSession());
    document.getElementById('btn-dash-join-session').addEventListener('click', () => this._openJoinModal());
    document.getElementById('btn-dash-goto-live').addEventListener('click', () => { location.hash = '#session'; });

    // Browse
    document.getElementById('browse-search').addEventListener('input', () => this._applyBrowseFilters());
    document.getElementById('filter-deity').addEventListener('change', () => this._applyBrowseFilters());
    document.getElementById('filter-language').addEventListener('change', () => this._applyBrowseFilters());
    document.getElementById('filter-tempo').addEventListener('change', () => this._applyBrowseFilters());
    document.getElementById('filter-level').addEventListener('change', () => this._applyBrowseFilters());

    // History
    document.getElementById('btn-add-backdated').addEventListener('click', () => this._openNewSession(true));

    // Singer back
    document.getElementById('btn-singer-back').addEventListener('click', () => history.back());
    document.getElementById('btn-session-detail-back').addEventListener('click', () => { location.hash = '#history'; });

    // Bhajan modal
    document.getElementById('mbhajan-close').addEventListener('click', () => this._closeBhajanModal());
    document.getElementById('modal-bhajan').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-bhajan')) this._closeBhajanModal();
    });
    document.getElementById('mbhajan-add-to-session').addEventListener('click', () => {
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
    document.getElementById('mbhajan-prev').addEventListener('click', () => {
      const ctx = this._bhajanModalContext;
      if (!ctx || ctx.index <= 0) return;
      const newIdx = ctx.index - 1;
      this._openBhajanModal(ctx.bhajans[newIdx], { ...ctx, index: newIdx });
    });
    document.getElementById('mbhajan-next').addEventListener('click', () => {
      const ctx = this._bhajanModalContext;
      if (!ctx || ctx.index >= ctx.bhajans.length - 1) return;
      const newIdx = ctx.index + 1;
      this._openBhajanModal(ctx.bhajans[newIdx], { ...ctx, index: newIdx });
    });

    // Session form modal
    document.getElementById('mform-close').addEventListener('click', () => this._closeModal('modal-session-form'));
    document.getElementById('btn-mform-cancel').addEventListener('click', () => this._closeModal('modal-session-form'));
    document.getElementById('modal-session-form').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-session-form')) this._closeModal('modal-session-form');
    });
    document.getElementById('btn-mform-submit').addEventListener('click', () => this._submitSessionForm());
    document.getElementById('sf-series').addEventListener('change', () => {
      const newInput = document.getElementById('sf-series-new');
      const isNew = document.getElementById('sf-series').value === '__new__';
      newInput.style.display = isNew ? '' : 'none';
      if (isNew) newInput.focus();
    });
    // Add Bhajan modal
    document.getElementById('mab-close').addEventListener('click', () => this._closeModal('modal-add-bhajan'));
    document.getElementById('btn-mab-cancel').addEventListener('click', () => this._closeModal('modal-add-bhajan'));
    document.getElementById('modal-add-bhajan').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-add-bhajan')) this._closeModal('modal-add-bhajan');
    });
    document.getElementById('mab-search').addEventListener('input', () => this._mabSearch());
    document.getElementById('btn-mab-back').addEventListener('click', () => this._mabGoStep(1));
    document.getElementById('btn-mab-add').addEventListener('click', () => this._mabConfirmAdd());
    document.getElementById('btn-pitch-gents').addEventListener('click', () => {
      const b = this._mabSelected;
      if (b?.gents_pitch) document.getElementById('mab-pitch').value = b.gents_pitch;
    });
    document.getElementById('btn-pitch-ladies').addEventListener('click', () => {
      const b = this._mabSelected;
      if (b?.ladies_pitch) document.getElementById('mab-pitch').value = b.ladies_pitch;
    });
    document.getElementById('mab-singer').addEventListener('change', () => this._mabUpdatePitchHint());
    document.getElementById('mab-singer').addEventListener('input', () => this._mabUpdatePitchHint());

    // Join modal
    document.getElementById('mjoin-close').addEventListener('click', () => this._closeModal('modal-join-session'));
    document.getElementById('btn-mjoin-cancel').addEventListener('click', () => this._closeModal('modal-join-session'));
    document.getElementById('btn-mjoin-join').addEventListener('click', () => this._joinSession());
    document.getElementById('mjoin-date').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._joinSession();
    });
    document.getElementById('modal-join-session').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-join-session')) this._closeModal('modal-join-session');
    });
  }

  _openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  _closeModal(id) {
    document.getElementById(id).classList.add('hidden');
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
    const titles = { idle: 'Not connected', syncing: 'Syncing…', ok: 'Synced to GitHub', error: 'Sync error', local: 'Local storage only' };
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

    this._openModal('modal-settings');
    if (!pat) setTimeout(() => document.getElementById('settings-pat').focus(), 100);
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
    const hour = now.getHours();
    const greeting = hour < 12 ? 'Good Morning 🙏' : hour < 17 ? 'Namaste 🙏' : 'Good Evening 🙏';
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

    // Live alert
    const liveAlert = document.getElementById('dash-live-alert');
    if (this.liveState) {
      liveAlert.classList.remove('hidden');
      document.getElementById('dash-live-text').textContent =
        `Live: ${this.liveState.label || 'Bhajan Session'} · ${(this.liveState.bhajans || []).length} bhajans`;
    } else {
      liveAlert.classList.add('hidden');
    }

    // Activity chart (last 14 days)
    const activity = this.sessions.activityLast30Days().slice(-14);
    const maxCount = Math.max(...activity.map(d => d.count), 1);
    const barsEl = document.getElementById('dash-activity-bars');
    barsEl.innerHTML = `<div class="activity-bars">
      ${activity.map(d => `
        <div class="activity-bar ${d.count > 0 ? 'has-data' : ''}"
          style="height:${Math.max(4, (d.count / maxCount) * 60)}px"
          title="${d.date}: ${d.count} session${d.count !== 1 ? 's' : ''}"></div>
      `).join('')}
    </div>`;

    // Top bhajans
    const top = this.sessions.topBhajans(5);
    const maxBhajan = top[0]?.count || 1;
    document.getElementById('dash-top-bhajans').innerHTML = top.length
      ? `<ul class="rank-list">${top.map((b, i) => `
          <li class="rank-item">
            <span class="rank-num">${i + 1}</span>
            <span class="rank-name" title="${escHtml(b.title)}">${escHtml(b.title)}</span>
            <div class="rank-bar-wrap"><div class="rank-bar" style="width:${(b.count / maxBhajan) * 100}%"></div></div>
            <span class="rank-count">${b.count}×</span>
          </li>`).join('')}</ul>`
      : '<p class="text-muted text-small">No sessions yet</p>';

    // Top singers
    const singers = this.sessions.topSingers(5);
    const maxSinger = singers[0]?.count || 1;
    document.getElementById('dash-top-singers').innerHTML = singers.length
      ? `<ul class="rank-list">${singers.map((s, i) => `
          <li class="rank-item">
            <span class="rank-num">${i + 1}</span>
            <a href="#singer/${encodeURIComponent(s.name)}" class="rank-name">${escHtml(s.name)}</a>
            <div class="rank-bar-wrap"><div class="rank-bar" style="width:${(s.count / maxSinger) * 100}%"></div></div>
            <span class="rank-count">${s.count}</span>
          </li>`).join('')}</ul>`
      : '<p class="text-muted text-small">No sessions yet</p>';

    // Deity distribution
    const deities = this.sessions.deityDistribution();
    const maxDeity = deities[0]?.count || 1;
    document.getElementById('dash-deities').innerHTML = deities.length
      ? `<ul class="rank-list">${deities.map((d) => `
          <li class="rank-item">
            <span class="rank-name">${escHtml(d.name)}</span>
            <div class="rank-bar-wrap"><div class="rank-bar" style="width:${(d.count / maxDeity) * 100}%"></div></div>
            <span class="rank-count">${d.count}</span>
          </li>`).join('')}</ul>`
      : '<p class="text-muted text-small">No sessions yet</p>';

    // Recent sessions
    const recent = this.sessions.all().slice(0, 4);
    document.getElementById('dash-recent-sessions').innerHTML = recent.length
      ? recent.map(s => this._sessionCardHTML(s)).join('')
      : `<div class="empty-state"><div class="empty-icon">📅</div><p>No sessions recorded yet. Start one!</p></div>`;

    // Click on session cards
    document.querySelectorAll('#dash-recent-sessions .session-card').forEach(el => {
      el.addEventListener('click', () => { location.hash = `#session-detail/${el.dataset.id}`; });
    });
  }

  _sessionCardHTML(s) {
    const singerList = (s.singers || []).slice(0, 3).join(', ') + (s.singers?.length > 3 ? ` +${s.singers.length - 3}` : '');
    const bCount = (s.bhajans || []).length;
    const badge = s.status === 'live'
      ? `<span class="session-card-badge badge-live">LIVE</span>`
      : s.isBackdated
      ? `<span class="session-card-badge badge-backdated">Backdated</span>`
      : `<span class="session-card-badge badge-completed">${bCount} bhajans</span>`;

    return `<div class="session-card" data-id="${s.id}">
      <div class="session-card-header">
        <div>
          <div class="session-card-date">${formatDate(s.date)}</div>
          <div class="session-card-label">${escHtml(s.label || 'Bhajan Session')}</div>
        </div>
        ${badge}
      </div>
      <div class="session-card-meta">
        ${singerList ? `<span class="session-meta-item">👥 ${escHtml(singerList)}</span>` : ''}
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
    return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
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
    if (series.length) select.value = series[0];
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
    this._applyBrowseFilters();
  }

  _applyBrowseFilters() {
    const q       = document.getElementById('browse-search').value;
    const deity   = document.getElementById('filter-deity').value;
    const language = document.getElementById('filter-language').value;
    const tempo   = document.getElementById('filter-tempo').value;
    const level   = document.getElementById('filter-level').value;

    const results = this.bhajans.search(q, { deity, language, tempo, level });
    this._browseFiltered = results;

    document.getElementById('browse-count-badge').textContent = results.length;
    this._renderBrowseList(results.slice(0, 100)); // render first 100 for performance

    if (results.length > 100) {
      document.getElementById('browse-list').insertAdjacentHTML('beforeend',
        `<p class="text-muted text-small" style="text-align:center;padding:1rem">
          Showing 100 of ${results.length} — refine your search to see more
        </p>`);
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

    return `<div class="bhajan-item" data-id="${b.id}">
      <div class="bhajan-item-main">
        <div class="bhajan-item-title">${escHtml(b.title)}</div>
        <div class="bhajan-item-meta">${escHtml([b.deity, b.language].filter(Boolean).join(' · '))}</div>
        <div class="bhajan-item-tags">
          ${b.tempo ? `<span class="bhajan-tag ${tempoClass}">${escHtml(b.tempo)}</span>` : ''}
          ${b.level ? `<span class="bhajan-tag ${levelClass}">${escHtml(b.level)}</span>` : ''}
          ${b.raga ? `<span class="bhajan-tag">${escHtml(b.raga.split('/')[0].trim())}</span>` : ''}
        </div>
      </div>
      <div class="bhajan-item-pitches">
        ${b.gents_pitch ? `<span class="pitch-badge pitch-gents" title="Gents pitch">${escHtml(b.gents_pitch.split('/')[0].trim())}</span>` : ''}
        ${b.ladies_pitch ? `<span class="pitch-badge pitch-ladies" title="Ladies pitch">${escHtml(b.ladies_pitch.split('/')[0].trim())}</span>` : ''}
      </div>
    </div>`;
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

    const metaFields = [
      ['Deity', b.deity], ['Language', b.language], ['Raga', b.raga],
      ['Beat', b.beat], ['Tempo', b.tempo], ['Level', b.level],
      ['Gents Pitch', b.gents_pitch], ['Ladies Pitch', b.ladies_pitch],
    ].filter(([, v]) => v);

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
            ${[...new Set((st.bhajans || []).map(e => e.singer).filter(Boolean))].map(name => `
              <div class="singer-chip clickable" data-singer="${escHtml(name)}" title="View ${escHtml(name)}'s profile">
                <div class="singer-avatar">${escHtml(name[0]?.toUpperCase() || '?')}</div>
                ${escHtml(name)}
              </div>`).join('')}
          </div>
        </div>

        ${isPlaying ? `
        <div class="now-singing-section">
          <div class="now-singing-label">Now Playing</div>
          <div class="now-singing-card" id="now-singing-card">
            ${this._nowSingingHTML(st)}
          </div>
        </div>` : ''}

        ${!isPlaying ? `<div class="session-add-btn-row">
          <button class="btn btn-primary" id="btn-add-bhajan-live">+ Add Bhajan</button>
          ${isHost ? `<button class="btn btn-success" id="btn-start-playing" ${(st.bhajans || []).length === 0 ? 'disabled' : ''}>▶ Start</button>
          <button class="btn btn-outline" id="btn-end-session">End Session</button>` : ''}
        </div>` : `<div class="session-add-btn-row">
          ${isHost ? `
          <button class="btn btn-outline" id="btn-prev-bhajan" ${(st.bhajans || []).findIndex(e => e.id === st.currentBhajan) <= 0 ? 'disabled' : ''}>← Prev</button>
          <button class="btn btn-primary" id="btn-next-bhajan">Next →</button>
          <button class="btn btn-ghost" id="btn-exit-play" title="Return to setup">↩ Setup</button>
          <button class="btn btn-outline" id="btn-end-session">End Session</button>` : ''}
          <button class="btn btn-ghost btn-aarati" id="btn-mangala-aarati" title="View Mangala Aarati lyrics">🪔 Mangala Aarati</button>
        </div>`}

        <div class="section-header" style="margin-top:.5rem">
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

      document.querySelectorAll('#live-bhajans-list .btn-reorder').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const dir = btn.dataset.action === 'reorder-later' ? 'later' : 'earlier';
          const newBhajans = this._moveBhajanEntry(btn.dataset.entryId, dir, this.liveState.bhajans || []);
          const updated = { ...this.liveState, bhajans: newBhajans };
          this._applyLiveEdit(updated, { type: 'reorder-bhajan', entryId: btn.dataset.entryId, direction: dir });
          this._renderSession();
        });
      });

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
      // Playing phase
      if (isHost) {
        document.getElementById('btn-prev-bhajan').addEventListener('click', () => this._prevBhajan());
        document.getElementById('btn-next-bhajan').addEventListener('click', () => this._nextBhajan());
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

    return `<div class="now-singing-info">
      <div class="now-singing-bhajan-title">${escHtml(entry.bhajan_title)}</div>
      <div class="now-singing-bhajan-meta">
        ${entry.singer ? `👤 ${escHtml(entry.singer)}` : ''}
        ${entry.singer && entry.pitch ? ' · ' : ''}
        ${entry.pitch ? `🎵 ${escHtml(entry.pitch)}` : ''}
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
      return `
      <div class="session-bhajan-entry${isCurrent ? ' session-entry-current' : ''}">
        <div class="entry-num">${i + 1}</div>
        <div class="entry-main">
          <div class="entry-title entry-title-link" data-bhajan-id="${e.bhajan_id}" data-entry-idx="${i}">${escHtml(e.bhajan_title)}</div>
          <div class="entry-meta">
            ${e.singer ? escHtml(e.singer) : ''}
            ${e.singer ? ' · ' : ''}
            <span class="${!isPlaying ? 'pitch-editable' : ''}" data-entry-id="${e.id}" data-mode="live" title="${!isPlaying ? 'Edit pitch' : ''}">
              ${e.pitch ? `<span class="pitch-badge pitch-gents">${escHtml(e.pitch)}</span>` : (!isPlaying ? `<span class="pitch-unset">+ pitch</span>` : '')}
            </span>
            ${!isPlaying
              ? ` · <span class="notes-editable" data-entry-id="${e.id}" data-mode="live" title="Edit notes">${e.notes ? `<em>${escHtml(e.notes)}</em>` : '<span class="pitch-unset">+ notes</span>'}</span>`
              : (e.notes ? ` · <em>${escHtml(e.notes)}</em>` : '')}
          </div>
        </div>
        <div class="entry-time">${formatTime(e.addedAt)}</div>
        ${!isPlaying ? `
        <div class="reorder-btns">
          <button class="btn btn-reorder" data-action="reorder-earlier" data-entry-id="${e.id}" ${canGoEarlier ? '' : 'disabled'} title="Move up">↑</button>
          <button class="btn btn-reorder" data-action="reorder-later" data-entry-id="${e.id}" ${canGoLater ? '' : 'disabled'} title="Move down">↓</button>
        </div>
        <div class="entry-actions">
          <button class="btn entry-action-btn" data-action="remove" data-entry-id="${e.id}" title="Remove">✕</button>
        </div>` : ''}
      </div>`;
    }).join('');
  }

  // ─── New Session Modal ────────────────────────────────────────────────────

  _sfIsBackdated = false;

  async _openNewSession(backdated = false) {
    this._sfIsBackdated = backdated;

    document.getElementById('sf-date').value = todayISO();
    document.getElementById('sf-time-group').style.display = backdated ? '' : 'none';
    document.getElementById('sf-backdated-note').style.display = backdated ? '' : 'none';

    const select   = document.getElementById('sf-series');
    const newInput = document.getElementById('sf-series-new');
    select.innerHTML = '<option value="" disabled selected>Loading…</option>';
    newInput.style.display = 'none';
    newInput.value = '';

    const submitBtn = document.getElementById('btn-mform-submit');
    submitBtn.textContent = backdated ? 'Add Session' : 'Start Session';
    document.getElementById('mform-title').textContent = backdated ? 'Add Past Session' : 'New Session';

    this._openModal('modal-session-form');

    const series = await this._fetchKnownSeries();
    this._populateSeriesSelect(select, series, true);
  }

  _submitSessionForm() {
    const seriesSelect = document.getElementById('sf-series');
    const series = seriesSelect.value === '__new__'
      ? document.getElementById('sf-series-new').value.trim()
      : seriesSelect.value;
    const date     = document.getElementById('sf-date').value;
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
    const updated = { ...this.liveState, phase: 'playing', currentBhajan: bhajans[0].id };
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
    this._toast('Session resumed with a new code', 'success');
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
    const el = document.getElementById('session-content');
    el.innerHTML = `<div class="connecting-state">
      <div class="connecting-spinner"></div>
      <p>Connecting to session <strong>${escHtml(code)}</strong>…</p>
    </div>`;
    location.hash = '#session';

    this.live = new LiveSession({
      onStateChange: (state) => {
        this.liveState = state;
        this._renderLiveSession(el);
      },
      onPeerChange: () => {},
      onError: (msg) => this._toast(msg, 'error'),
    });

    try {
      await this.live.join(code);
    } catch (err) {
      this._toast(err.message, 'error');
      this.live.leave();
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
    document.getElementById('mab-pitch-hint').textContent = '';

    // Populate singer autocomplete: session bhajan singers first, then all historical
    document.getElementById('mab-singer').value = '';
    const sessionSingers = new Set((this.liveState?.bhajans || []).map(e => e.singer).filter(Boolean));
    const allSingers = this.sessions.allSingerNames?.() || [];
    const suggestions = [...sessionSingers, ...allSingers.filter(n => !sessionSingers.has(n))];
    document.getElementById('mab-singer-list').innerHTML =
      suggestions.map(s => `<option value="${escHtml(s)}">`).join('');

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

    // Set pitch buttons labels
    document.getElementById('btn-pitch-gents').textContent = b.gents_pitch ? `Gents: ${b.gents_pitch.split('/')[0].trim()}` : 'Gents';
    document.getElementById('btn-pitch-ladies').textContent = b.ladies_pitch ? `Ladies: ${b.ladies_pitch.split('/')[0].trim()}` : 'Ladies';
    document.getElementById('btn-pitch-gents').style.display = b.gents_pitch ? '' : 'none';
    document.getElementById('btn-pitch-ladies').style.display = b.ladies_pitch ? '' : 'none';

    this._mabUpdatePitchHint();
  }

  _mabUpdatePitchHint() {
    const singer = document.getElementById('mab-singer').value;
    const b = this._mabSelected;
    const hintEl = document.getElementById('mab-pitch-hint');
    const pitchInput = document.getElementById('mab-pitch');

    if (singer && b) {
      // Check if singer has sung this bhajan before
      const prevPitch = this.sessions.singerBhajanPitch(singer, b.id);
      if (prevPitch) {
        pitchInput.value = prevPitch;
        hintEl.textContent = `↺ ${singer} sang this at ${prevPitch} before`;
        return;
      }
      // Fall back to singer's usual pitch
      const usual = this.sessions.singerUsualPitch(singer);
      if (usual) {
        hintEl.textContent = `💡 ${singer}'s usual pitch: ${usual}`;
        if (!pitchInput.value) pitchInput.value = usual;
        return;
      }
    }
    hintEl.textContent = '';
    // Default: gents pitch
    if (!pitchInput.value && b?.gents_pitch) pitchInput.value = b.gents_pitch;
  }

  _mabConfirmAdd() {
    const b = this._mabSelected;
    if (!b) return;

    const singer = document.getElementById('mab-singer').value;
    const pitch  = document.getElementById('mab-pitch').value.trim();
    const notes  = document.getElementById('mab-notes').value.trim();

    const entry = {
      id: genId('e'),
      bhajan_id:    b.id,
      bhajan_title: b.title,
      bhajan_deity: b.deity,
      singer: singer || null,
      pitch:  pitch || null,
      notes:  notes || null,
      addedAt: Date.now(),
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


  // ─── End Session ──────────────────────────────────────────────────────────

  _confirmEndSession() {
    const bhCount = (this.liveState?.bhajans || []).length;
    if (!confirm(`End session? ${bhCount} bhajans will be saved.`)) return;
    this._endSession();
  }

  _endSession() {
    const started = this.liveState.createdAt ? new Date(this.liveState.createdAt) : null;
    const duration = started ? Math.round((Date.now() - started.getTime()) / 1000) : null;

    const singers = [...new Set((this.liveState.bhajans || []).map(e => e.singer).filter(Boolean))];

    const finalSession = {
      ...this.liveState,
      singers,
      status: 'completed',
      endedAt: new Date().toISOString(),
      duration,
    };

    this.sessions.save(finalSession);
    this.sessions.clearDraft();

    this.live?.leave();
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
    this.sessions.save(sessionData);
    location.hash = `#session-detail/${sessionData.id}`;
    this._toast('Session created. Add bhajans below.', 'success');
  }

  // ─── History ──────────────────────────────────────────────────────────────

  _renderHistory() {
    const all = this.sessions.all();
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
      card.addEventListener('click', () => { location.hash = `#session-detail/${card.dataset.id}`; });
    });
  }

  // ─── Inline pitch edit ───────────────────────────────────────────────────

  _pitchOptionsHTML(current) {
    const groups = {
      'Pancham (Sa = C)': ['1 Pancham / C','1.5 Pancham / C#','2 Pancham / D','2.5 Pancham / E','3 Pancham / E','4 Pancham / F','4.5 Pancham / F#','5 Pancham / G','5.5 Pancham / G#','6 Pancham / A','6.5 Pancham / A#','7 Pancham / B'],
      'Madhyam (Sa = F)': ['1 Madhyam / F','1.5 Madhyam / F#','2 Madhyam / G','2.5 Madhyam / G#','3 Madhyam / A','4 Madhyam / A#','4.5 Madhyam / B','5 Madhyam / C','5.5 Madhyam / C#','6 Madhyam / D','6.5 Madhyam / E','7 Madhyam / E'],
    };
    const sel = v => v === current ? ' selected' : '';
    return `<option value=""${sel('')}>— not set —</option>` +
      Object.entries(groups).map(([label, opts]) =>
        `<optgroup label="${label}">${opts.map(v => `<option${sel(v)}>${escHtml(v)}</option>`).join('')}</optgroup>`
      ).join('');
  }

  _inlinePitchEdit(triggerEl, entryId, mode) {
    const entries = mode === 'live'
      ? (this.liveState?.bhajans || [])
      : (this.sessions.get(this._detailSessionId)?.bhajans || []);
    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    const sel = document.createElement('select');
    sel.className = 'pitch-inline-select form-input';
    sel.innerHTML = this._pitchOptionsHTML(entry.pitch || '');

    triggerEl.replaceWith(sel);
    sel.focus();

    const save = () => {
      const newPitch = sel.value || null;
      if (mode === 'live') {
        const updated = {
          ...this.liveState,
          bhajans: (this.liveState.bhajans || []).map(e =>
            e.id === entryId ? { ...e, pitch: newPitch } : e),
        };
        this._applyLiveEdit(updated, { type: 'update-pitch', entryId, pitch: newPitch });
        this._renderSession();
      } else {
        const session = this.sessions.get(this._detailSessionId);
        if (!session) return;
        const updated = {
          ...session,
          bhajans: session.bhajans.map(e =>
            e.id === entryId ? { ...e, pitch: newPitch } : e),
        };
        this.sessions.save(updated);
        this._renderSessionDetail(this._detailSessionId);
      }
    };

    let done = false;
    sel.addEventListener('change', () => { done = true; save(); });
    sel.addEventListener('blur', () => { if (!done) { done = true; sel.replaceWith(triggerEl); } });
    sel.addEventListener('keydown', ev => {
      if (ev.key === 'Escape') { done = true; sel.replaceWith(triggerEl); }
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
        this.sessions.save(updated);
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

    document.getElementById('session-detail-content').innerHTML = `
      <div class="session-detail-header">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:1rem">
          <div>
            <div class="session-detail-title">${escHtml(s.label || 'Bhajan Session')}</div>
            <div class="session-detail-date">${formatDate(s.date)}${s.isBackdated ? ' · Backdated' : ''}</div>
          </div>
          <div style="display:flex;gap:.4rem;flex-shrink:0">
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
            ${(s.bhajans).map((e, i) => `
              <div class="timeline-item">
                <div class="tl-num">${i + 1}</div>
                <div class="tl-main">
                  <div class="tl-title tl-title-link" data-bhajan-id="${e.bhajan_id}" data-entry-idx="${i}">${escHtml(e.bhajan_title)}</div>
                  <div class="tl-meta">
                    ${e.singer ? `👤 ${escHtml(e.singer)}` : ''}
                    ${e.singer ? ' · ' : ''}
                    <span class="${canEdit ? 'pitch-editable' : ''}" data-entry-id="${e.id}" data-mode="detail" title="${canEdit ? 'Edit pitch' : ''}">
                      ${e.pitch ? `🎵 <span class="pitch-badge pitch-gents">${escHtml(e.pitch)}</span>` : (canEdit ? `<span class="pitch-unset">+ pitch</span>` : '')}
                    </span>
                  </div>
                  ${canEdit
                    ? `<div class="tl-notes notes-editable" data-entry-id="${e.id}" data-mode="detail" title="Edit notes">${e.notes ? escHtml(e.notes) : '<span class="pitch-unset">+ notes</span>'}</div>`
                    : (e.notes ? `<div class="tl-notes">${escHtml(e.notes)}</div>` : '')}
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.3rem">
                  <span class="tl-time">${formatTime(e.addedAt)}</span>
                  ${canEdit ? `
                  <div class="reorder-btns" style="flex-direction:row">
                    <button class="btn btn-reorder" data-action="reorder-earlier" data-entry-id="${e.id}" ${i > 0 ? '' : 'disabled'} title="Move up">↑</button>
                    <button class="btn btn-reorder" data-action="reorder-later" data-entry-id="${e.id}" ${i < (s.bhajans.length - 1) ? '' : 'disabled'} title="Move down">↓</button>
                  </div>
                  <button class="btn btn-ghost btn-sm entry-action-btn" data-action="remove" data-entry-id="${e.id}" style="color:var(--text-3);font-size:.75rem">✕</button>` : ''}
                </div>
              </div>`).join('')}
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
          this.sessions.save({ ...current, bhajans: newBhajans });
          this._renderSessionDetail(id);
        });
      });

      document.querySelectorAll('#session-detail-content .entry-action-btn[data-action="remove"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updated = { ...s, bhajans: (s.bhajans || []).filter(e => e.id !== btn.dataset.entryId) };
          this.sessions.save(updated);
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
    // Temporarily set liveState for the add modal to work
    const prevLive = this.liveState;
    const prevLiveConn = this.live;
    this.liveState = { ...session };
    this.live = null; // not actually live

    this._openAddBhajanModal();

    // Override the confirm button to save to history instead
    const origConfirm = this._mabConfirmAdd.bind(this);
    this._mabConfirmAdd = () => {
      const b = this._mabSelected;
      if (!b) return;
      const singer = document.getElementById('mab-singer').value;
      const pitch  = document.getElementById('mab-pitch').value.trim();
      const notes  = document.getElementById('mab-notes').value.trim();

      const entry = {
        id: genId('e'),
        bhajan_id: b.id, bhajan_title: b.title, bhajan_deity: b.deity,
        singer: singer || null, pitch: pitch || null, notes: notes || null,
        addedAt: Date.now(),
      };
      const newBhajans = [...(session.bhajans || []), entry];
      const singers = [...new Set(newBhajans.map(e => e.singer).filter(Boolean))];
      const updated = { ...session, bhajans: newBhajans, singers };
      this.sessions.save(updated);

      this._closeModal('modal-add-bhajan');
      this.liveState = prevLive;
      this.live = prevLiveConn;
      this._mabConfirmAdd = origConfirm;
      this._renderSessionDetail(session.id);
      this._toast(`Added: ${b.title}`, 'success');
    };
  }

  // ─── Singer Profile ───────────────────────────────────────────────────────

  _renderSinger(name) {
    const { sessions, bhajans, usualPitch, uniqueBhajans } = this.sessions.singerHistory(name);

    document.getElementById('singer-content').innerHTML = `
      <div class="singer-header">
        <div class="singer-big-avatar">${escHtml(name[0]?.toUpperCase() || '?')}</div>
        <div>
          <div class="singer-info-name">${escHtml(name)}</div>
          <div class="singer-stats-row">
            <span>${sessions.length} session${sessions.length !== 1 ? 's' : ''}</span>
            <span>${bhajans.length} bhajans sung</span>
            ${usualPitch ? `<span>Usually at ${escHtml(usualPitch)}</span>` : ''}
          </div>
        </div>
      </div>

      <div class="section-header">
        <h3 class="section-title">Bhajans Sung</h3>
      </div>

      ${uniqueBhajans.length
        ? `<div class="bhajan-list">
            ${uniqueBhajans.map(b => `
              <div class="singer-bhajan-item" data-bhajan-id="${b.id}">
                <div class="bhajan-item-main">
                  <div class="bhajan-item-title">${escHtml(b.title)}</div>
                  ${b.lastPitch ? `<div class="bhajan-item-meta">Last pitch: ${escHtml(b.lastPitch)}</div>` : ''}
                </div>
                <span class="singer-bhajan-count">${b.count}×</span>
              </div>`).join('')}
          </div>`
        : `<div class="empty-state"><p class="text-muted">No bhajans recorded for ${escHtml(name)} yet</p></div>`}

      ${sessions.length ? `
        <div class="section-header" style="margin-top:1.5rem">
          <h3 class="section-title">Sessions</h3>
        </div>
        ${sessions.slice(0, 10).map(s => this._sessionCardHTML(s)).join('')}` : ''}
    `;

    // Bhajan click → detail modal
    document.querySelectorAll('#singer-content .singer-bhajan-item').forEach(el => {
      el.addEventListener('click', () => this._openBhajanModal(el.dataset.bhajanId));
    });
    document.querySelectorAll('#singer-content .session-card').forEach(card => {
      card.addEventListener('click', () => { location.hash = `#session-detail/${card.dataset.id}`; });
    });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', () => { window._app = new App(); });
