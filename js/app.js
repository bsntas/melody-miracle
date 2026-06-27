import { BhajanStore, SessionStore, genId, formatDate, formatTime, todayISO, monthLabel, escHtml } from './store.js';
import { LiveSession } from './live.js';

// ─── App ──────────────────────────────────────────────────────────────────────

class App {
  constructor() {
    this.bhajans   = new BhajanStore();
    this.sessions  = new SessionStore();
    this.live      = null;  // LiveSession instance when active
    this.liveState = null;  // current live session state (host or observer)

    this._toastTimer = null;
    this._browseFiltered = [];
    this._mabSelected  = null; // bhajan selected in Add Bhajan modal
    this._mabStep      = 1;

    this._init();
  }

  async _init() {
    try {
      await this.bhajans.load();
    } catch (e) {
      document.getElementById('loading-text').textContent = 'Failed to load. Please refresh.';
      return;
    }

    this._populateFilters();
    this._bindGlobal();
    this._hideLoading();
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
      if (!this.liveState || !this.live?.isHost) {
        this._toast('No active session. Start a session first.', 'warn');
        return;
      }
      const bhajan = this.bhajans.getById(id);
      if (bhajan) this._openAddBhajanModal(bhajan);
    });

    // Session form modal
    document.getElementById('mform-close').addEventListener('click', () => this._closeModal('modal-session-form'));
    document.getElementById('btn-mform-cancel').addEventListener('click', () => this._closeModal('modal-session-form'));
    document.getElementById('modal-session-form').addEventListener('click', e => {
      if (e.target === document.getElementById('modal-session-form')) this._closeModal('modal-session-form');
    });
    document.getElementById('btn-mform-submit').addEventListener('click', () => this._submitSessionForm());
    document.getElementById('btn-sf-add-singer').addEventListener('click', () => this._sfAddSinger());
    document.getElementById('sf-singer-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this._sfAddSinger(); }
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

    // Join modal
    document.getElementById('mjoin-close').addEventListener('click', () => this._closeModal('modal-join-session'));
    document.getElementById('btn-mjoin-cancel').addEventListener('click', () => this._closeModal('modal-join-session'));
    document.getElementById('btn-mjoin-join').addEventListener('click', () => this._joinSession());
    document.getElementById('mjoin-code').addEventListener('keydown', e => {
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

  _openBhajanModal(id) {
    const b = this.bhajans.getById(id);
    if (!b) return;

    document.getElementById('mbhajan-title').textContent = b.title;
    document.getElementById('mbhajan-add-to-session').dataset.bhajanId = id;

    const canAdd = !!(this.liveState && this.live?.isHost);
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
    this._closeModal('modal-bhajan');
    // Pause audio if playing
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
        <div class="session-home-desc">Start a session to record bhajans. Share the code so others can follow along live.</div>
        <div class="session-home-actions">
          <button class="btn btn-primary btn-lg btn-block" id="btn-session-new">+ Start New Session</button>
          ${draft ? `<div style="width:100%">
            <button class="btn btn-warning btn-block" id="btn-session-resume">↩ Resume "${escHtml(draft.label || 'Previous Session')}"</button>
          </div>` : ''}
          <span class="session-home-or">— or join an existing one —</span>
          <div class="session-join-row">
            <input type="text" id="session-join-code" class="form-input code-input"
              placeholder="Enter code" maxlength="6" autocapitalize="characters"
              autocomplete="off" spellcheck="false">
            <button class="btn btn-outline" id="btn-session-join">Join →</button>
          </div>
        </div>
      </div>`;
  }

  _bindSessionHome(draft) {
    document.getElementById('btn-session-new').addEventListener('click', () => this._openNewSession());
    document.getElementById('btn-session-join').addEventListener('click', () => {
      const code = document.getElementById('session-join-code').value.trim();
      if (code) this._joinSessionWithCode(code);
      else this._openJoinModal();
    });
    document.getElementById('session-join-code').addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const code = e.target.value.trim();
        if (code) this._joinSessionWithCode(code);
      }
    });
    if (draft) {
      document.getElementById('btn-session-resume')?.addEventListener('click', () => this._resumeDraftSession(draft));
    }
  }

  _renderLiveSession(el) {
    const st = this.liveState;
    const isHost = this.live?.isHost;

    el.innerHTML = `
      <div class="live-session-view">
        ${!isHost ? '<div class="observer-banner">👁 Observer mode — watching live</div>' : ''}

        <div class="live-header">
          <div class="live-header-top">
            <div>
              <div class="live-session-label">${escHtml(st.label || 'Bhajan Session')}</div>
              <div class="live-session-date">${formatDate(st.date)}</div>
            </div>
            <div class="session-code-wrap">
              <div class="session-code" id="live-code" title="Click to copy">${escHtml(st.roomCode || '')}</div>
              <button class="btn btn-outline btn-sm" id="btn-copy-code">Copy</button>
            </div>
          </div>
          <div class="observer-count" id="live-observer-count">
            ${isHost ? `${this.live?.peerCount || 0} observer${(this.live?.peerCount || 0) !== 1 ? 's' : ''}` : ''}
          </div>
          <div class="singers-strip">
            ${(st.singers || []).map(name => `
              <div class="singer-chip clickable" data-singer="${escHtml(name)}" title="View ${escHtml(name)}'s profile">
                <div class="singer-avatar">${escHtml(name[0]?.toUpperCase() || '?')}</div>
                ${escHtml(name)}
              </div>`).join('')}
            ${isHost ? `<button class="btn btn-outline btn-sm" id="btn-add-singer-live" style="border-radius:999px;padding:.2rem .6rem;font-size:.78rem">+ Singer</button>` : ''}
          </div>
        </div>

        <div class="now-singing-section">
          <div class="now-singing-label">Now Singing</div>
          <div class="now-singing-card" id="now-singing-card">
            ${this._nowSingingHTML(st)}
          </div>
        </div>

        ${isHost ? `<div class="session-add-btn-row">
          <button class="btn btn-primary" id="btn-add-bhajan-live">+ Add Bhajan</button>
          <button class="btn btn-outline" id="btn-end-session">End Session</button>
        </div>` : ''}

        <div class="section-header" style="margin-top:.5rem">
          <h3 class="section-title">Bhajans Sung (${(st.bhajans || []).length})</h3>
        </div>
        <div class="session-bhajans-list" id="live-bhajans-list">
          ${this._sessionBhajansHTML(st.bhajans || [], isHost)}
        </div>

        ${!isHost ? '<div class="session-offline-note">🔄 Live updates as bhajans are added</div>' : ''}
      </div>`;

    // Bind events
    document.getElementById('live-code').addEventListener('click', () => this._copyCode(st.roomCode));
    document.getElementById('btn-copy-code').addEventListener('click', () => this._copyCode(st.roomCode));

    document.querySelectorAll('.singer-chip.clickable').forEach(el => {
      el.addEventListener('click', () => {
        location.hash = `#singer/${encodeURIComponent(el.dataset.singer)}`;
      });
    });

    if (isHost) {
      document.getElementById('btn-add-bhajan-live').addEventListener('click', () => this._openAddBhajanModal());
      document.getElementById('btn-end-session').addEventListener('click', () => this._confirmEndSession());
      document.getElementById('btn-add-singer-live')?.addEventListener('click', () => this._addSingerLive());

      document.querySelectorAll('.entry-action-btn[data-action="remove"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this._removeBhajanEntry(btn.dataset.entryId);
        });
      });
      document.querySelectorAll('.entry-action-btn[data-action="now"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          this._setCurrentBhajan(btn.dataset.entryId);
        });
      });
    }

    // Update live indicator in nav
    document.getElementById('bnav-session-icon').classList.add('is-live');
  }

  _nowSingingHTML(st) {
    const currentId = st.currentBhajan;
    const entry = currentId ? (st.bhajans || []).find(e => e.id === currentId) : (st.bhajans || []).at(-1);
    if (!entry) return '<span class="now-singing-empty">Session started — add first bhajan</span>';

    return `<div class="now-singing-info">
      <div class="now-singing-bhajan-title">${escHtml(entry.bhajan_title)}</div>
      <div class="now-singing-bhajan-meta">
        ${entry.singer ? `👤 ${escHtml(entry.singer)}` : ''}
        ${entry.singer && entry.pitch ? ' · ' : ''}
        ${entry.pitch ? `🎵 ${escHtml(entry.pitch)}` : ''}
      </div>
    </div>`;
  }

  _sessionBhajansHTML(bhajans, isHost = false) {
    if (!bhajans.length) return '<div class="empty-state" style="padding:1.5rem 0"><p class="text-muted">No bhajans added yet</p></div>';

    return [...bhajans].reverse().map((e, i) => `
      <div class="session-bhajan-entry">
        <div class="entry-num">${bhajans.length - i}</div>
        <div class="entry-main">
          <div class="entry-title">${escHtml(e.bhajan_title)}</div>
          <div class="entry-meta">
            ${e.singer ? escHtml(e.singer) : ''}
            ${e.singer && e.pitch ? ' · ' : ''}
            ${e.pitch ? `<span class="pitch-badge pitch-gents">${escHtml(e.pitch)}</span>` : ''}
            ${e.notes ? ` · <em>${escHtml(e.notes)}</em>` : ''}
          </div>
        </div>
        <div class="entry-time">${formatTime(e.addedAt)}</div>
        ${isHost ? `<div class="entry-actions">
          <button class="btn entry-action-btn" data-action="now" data-entry-id="${e.id}" title="Mark as current">▶</button>
          <button class="btn entry-action-btn" data-action="remove" data-entry-id="${e.id}" title="Remove">✕</button>
        </div>` : ''}
      </div>`).join('');
  }

  _copyCode(code) {
    navigator.clipboard.writeText(code)
      .then(() => this._toast('Code copied!'))
      .catch(() => this._toast('Code: ' + code));
  }

  // ─── New Session Modal ────────────────────────────────────────────────────

  _sfSingers = [];
  _sfIsBackdated = false;

  _openNewSession(backdated = false) {
    this._sfSingers = [];
    this._sfIsBackdated = backdated;

    document.getElementById('sf-label').value = '';
    document.getElementById('sf-date').value = todayISO();
    document.getElementById('sf-singers-tags').innerHTML = '';
    document.getElementById('sf-singer-input').value = '';
    document.getElementById('sf-time-group').style.display = backdated ? '' : 'none';
    document.getElementById('sf-backdated-note').style.display = backdated ? '' : 'none';

    const submitBtn = document.getElementById('btn-mform-submit');
    submitBtn.textContent = backdated ? 'Add Session' : 'Start Session';
    document.getElementById('mform-title').textContent = backdated ? 'Add Past Session' : 'New Session';

    // Pre-fill known singer names as suggestions
    const known = this.sessions.allSingerNames();
    // We'll just show the input — no autocomplete for now to keep it simple

    this._openModal('modal-session-form');
    setTimeout(() => document.getElementById('sf-label').focus(), 100);
  }

  _sfAddSinger() {
    const input = document.getElementById('sf-singer-input');
    const name = input.value.trim();
    if (!name || this._sfSingers.includes(name)) { input.value = ''; return; }
    this._sfSingers.push(name);
    input.value = '';
    this._renderSfSingers();
  }

  _renderSfSingers() {
    document.getElementById('sf-singers-tags').innerHTML = this._sfSingers.map(name => `
      <span class="singer-remove-chip">
        ${escHtml(name)}
        <button data-name="${escHtml(name)}" title="Remove">✕</button>
      </span>`).join('');
    document.querySelectorAll('#sf-singers-tags .singer-remove-chip button').forEach(btn => {
      btn.addEventListener('click', () => {
        this._sfSingers = this._sfSingers.filter(n => n !== btn.dataset.name);
        this._renderSfSingers();
      });
    });
  }

  _submitSessionForm() {
    const label    = document.getElementById('sf-label').value.trim();
    const date     = document.getElementById('sf-date').value;
    const singers  = [...this._sfSingers];
    const backdated = this._sfIsBackdated;

    if (!date) { this._toast('Please set a date', 'error'); return; }
    if (backdated && !date) { this._toast('Date required for backdated session', 'error'); return; }

    const sessionData = {
      id: genId('sess'),
      label:  label || 'Bhajan Session',
      date,
      singers,
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

    const code = this.live.host(sessionData);
    sessionData.roomCode = code;

    this.liveState = { ...sessionData };
    this.sessions.saveDraft(this.liveState);

    location.hash = '#session';
    this._renderSession();
    this._toast(`Session started! Code: ${code}`, 'success');
  }

  _resumeDraftSession(draft) {
    const sessionData = { ...draft, status: 'live' };
    // Create a new room (new code since old one is gone)
    this._startLiveSession(sessionData);
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

  _openJoinModal() {
    document.getElementById('mjoin-code').value = '';
    document.getElementById('mjoin-name').value = '';
    this._openModal('modal-join-session');
    setTimeout(() => document.getElementById('mjoin-code').focus(), 100);
  }

  async _joinSession() {
    const code = document.getElementById('mjoin-code').value.trim().toUpperCase();
    if (!code || code.length < 4) { this._toast('Enter a valid session code', 'error'); return; }
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

  // ─── Add Singer during live session ──────────────────────────────────────

  _addSingerLive() {
    const name = prompt('Singer name:')?.trim();
    if (!name) return;
    if ((this.liveState.singers || []).includes(name)) { this._toast('Already added', 'warn'); return; }
    const updated = { ...this.liveState, singers: [...(this.liveState.singers || []), name] };
    this.liveState = updated;
    this.live.updateState(updated);
    this._renderSession();
  }

  // ─── Add Bhajan Modal ─────────────────────────────────────────────────────

  _openAddBhajanModal(preselect = null) {
    this._mabSelected = preselect || null;
    this._mabStep = preselect ? 2 : 1;

    document.getElementById('mab-search').value = '';
    document.getElementById('mab-notes').value = '';
    document.getElementById('mab-pitch').value = '';
    document.getElementById('mab-pitch-hint').textContent = '';

    // Populate singer dropdown
    const singers = this.liveState?.singers || [];
    const singerSel = document.getElementById('mab-singer');
    singerSel.innerHTML = `<option value="">— not specified —</option>` +
      singers.map(s => `<option value="${escHtml(s)}">${escHtml(s)}</option>`).join('');

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
      currentBhajan: entry.id,
    };

    this.liveState = updated;
    this.live.updateState(updated);
    this.sessions.saveDraft(updated);

    this._closeModal('modal-add-bhajan');
    this._renderSession();
    this._toast(`Added: ${b.title}`, 'success');
  }

  // ─── Remove / set current bhajan ─────────────────────────────────────────

  _removeBhajanEntry(entryId) {
    const updated = {
      ...this.liveState,
      bhajans: (this.liveState.bhajans || []).filter(e => e.id !== entryId),
      currentBhajan: this.liveState.currentBhajan === entryId ? null : this.liveState.currentBhajan,
    };
    this.liveState = updated;
    this.live.updateState(updated);
    this._renderSession();
  }

  _setCurrentBhajan(entryId) {
    const updated = { ...this.liveState, currentBhajan: entryId };
    this.liveState = updated;
    this.live.updateState(updated);
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

    const finalSession = {
      ...this.liveState,
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

  // ─── Session Detail ───────────────────────────────────────────────────────

  _renderSessionDetail(id) {
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
                  <div class="tl-title">${escHtml(e.bhajan_title)}</div>
                  <div class="tl-meta">
                    ${e.singer ? `👤 ${escHtml(e.singer)}` : ''}
                    ${e.singer && e.pitch ? ' · ' : ''}
                    ${e.pitch ? `🎵 ${escHtml(e.pitch)}` : ''}
                  </div>
                  ${e.notes ? `<div class="tl-notes">${escHtml(e.notes)}</div>` : ''}
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.3rem">
                  <span class="tl-time">${formatTime(e.addedAt)}</span>
                  ${canEdit ? `<button class="btn btn-ghost btn-sm entry-action-btn" data-action="remove" data-entry-id="${e.id}" style="color:var(--text-3);font-size:.75rem">✕</button>` : ''}
                </div>
              </div>`).join('')}
          </div>`
        : `<div class="empty-state"><p class="text-muted">No bhajans in this session${canEdit ? '. Use "+ Bhajan" to add.' : '.'}</p></div>`}
    `;

    // Bind singer clicks
    document.querySelectorAll('#session-detail-content .singer-chip.clickable').forEach(el => {
      el.addEventListener('click', () => { location.hash = `#singer/${encodeURIComponent(el.dataset.singer)}`; });
    });

    // Add bhajan to completed/backdated session
    if (canEdit) {
      document.getElementById('btn-detail-add-bhajan')?.addEventListener('click', () => {
        this._openDetailAddBhajan(s);
      });
      document.querySelectorAll('#session-detail-content .entry-action-btn[data-action="remove"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const updated = { ...s, bhajans: (s.bhajans || []).filter(e => e.id !== btn.dataset.entryId) };
          this.sessions.save(updated);
          this._renderSessionDetail(id);
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
      const updated = { ...session, bhajans: [...(session.bhajans || []), entry] };
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
