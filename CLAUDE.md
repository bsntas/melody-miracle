# Melody Miracle — Codebase Context

## IMPORTANT: Version bump required on every change

Whenever any of `js/app.js`, `css/style.css`, `js/github-store.js`, `js/live.js`, `js/auth.js`, `js/store.js`, or `js/favourites.js` is modified, you **must** bump versions in the same commit:

1. **`sw.js`** — update `CACHE` and the matching `V_*` constant(s) for every changed file. Use the format `YYYYMMDD.N` (today's date, incrementing N from the current highest value). Update the inline comment to describe the change.
2. **`index.html`** — update the `?v=` query strings on `<link>` and `<script>` tags for every changed file to match the new `V_*` values in `sw.js`.

Forgetting this means the service worker serves stale cached files and users won't see the changes.

## What this is

A **vanilla JS PWA** for managing bhajan (devotional song) sessions. No framework, no build step — plain HTML5, CSS, and ES modules. Works offline via a service worker and syncs sessions to GitHub as a JSON file.

## Architecture at a glance

```
index.html          Single-page shell; all views declared here as hidden divs
js/app.js           Main controller (~4 400 lines) — routing, rendering, all UI logic
js/store.js         BhajanStore (bhajans.json wrapper) + SessionStore (localStorage + fetch)
js/github-store.js  Extends SessionStore — commits sessions.json to GitHub via PAT
js/live.js          Firebase Realtime DB — live session sync between host and participants
js/auth.js          Google auth via Firebase
js/favourites.js    Per-user favourites in Firebase
css/style.css       All styles in one file (~93 KB)
data/bhajans.json   Generated catalog of ~1 450 bhajans (run scripts/build-bhajans.py)
data/sessions.json  Committed session history (source of truth for history view)
bhajans/            Markdown source files, one per bhajan
scripts/            Python data-pipeline scripts
```

## Key data models

**Bhajan** (from `data/bhajans.json`):
```
id, title, deity, language, raga, beat, tempo, level,
gents_pitch, ladies_pitch, gents_pitch_indian, gents_pitch_western,
ladies_pitch_indian, ladies_pitch_western, scale, lyrics, meaning,
audio_url, source_url
```

**Session** (stored in `data/sessions.json` and localStorage draft):
```
id, label, date, series, status ("live"|"completed"), phase ("setup"|"playing"|"ended"),
roomCode, createdAt, startedAt, endedAt, duration, isBackdated,
currentBhajan, singers[], bhajans[]
```

**Session bhajan entry** (each item in `session.bhajans[]`):
```
id, bhajan_id, bhajan_title, bhajan_deity, pitch, pitch_indian, pitch_western,
singers[], notes, addedAt
```

## Routing

Hash-based: `location.hash = '#view/param'`. All routing handled in `app.js` via a `_route()` method. Main views: `#dashboard`, `#browse`, `#session`, `#session-detail/<id>`, `#singer/<name>`, `#history`.

## Deity system

Deity is a first-class field. Every bhajan has a `deity` string (can be comma-separated for multi-deity, e.g. `"Sai, Rama, Narayana"`). Session entries denormalize it as `bhajan_deity`.

20 deity values in catalog: Allah, Anjaneya, Ayyappa, Buddha, Devi, Ganesha, Guru, Hari, Jehovah, Jesus, Krishna, Narasimha, Narayana, Patriotic, Rama, Sai, Sarva Dharma, Shiva, Subrahmanya, Vittala.

**`_deitySlug(deity)`** (app.js) — maps deity string → CSS slug (`ganesha`, `shiva`, `vishnu`, `devi`, `rama`, `krishna`, `hanuman`, `murugan`, `ayyappa`, `other`).

**Deity CSS**: `.deity-pill.deity-<slug>` gives color-coded pills. Dark-mode overrides exist. All color definitions are in `css/style.css` lines ~1290–1320 (light) and ~1509–1520 (dark).

**Ganesha first-bhajan convention**: If no Ganesha bhajan is in the session yet, a dashed placeholder shows at position 1. Enforced in `_sessionBhajansHTML()` and the add-bhajan flow.

## Key rendering methods (all in app.js)

| Method | What it renders |
|---|---|
| `_sessionBhajansHTML(bhajans, isHost, phase, isEditMode)` | Bhajan list in the **live session** view |
| `_sessionHomeHTML()` | My Sessions section: draft card + host/observer bg-session cards |
| `_renderSessionDetail(id)` | Completed session detail (timeline of bhajans) |
| `_sessionCardHTML(session)` | Session cards on dashboard and history list |
| `_renderSingers()` | Singers directory with per-singer stats |
| `_renderBrowse()` | Browse/search view with deity filter |

## Firebase

Project: `melody-miracle`, region: `asia-southeast1`.
DB paths: `melody-miracle/sessions/<roomCode>/state`, `.../observers/`, `melody-miracle/users/<uid>/profile`, `.../favourites/<bhajanId>`.

## Pitch vocabulary

24 options defined in `PITCH_OPTIONS` (app.js lines 15–40): two series (Pancham / Madhyam), each with `{ combined, indian, western, series }`.

## How to add a bhajan

Edit a Markdown file in `bhajans/`, then run `python scripts/build-bhajans.py` to regenerate `data/bhajans.json`.

## Auth gate pattern

Protected write actions call `await this.requireAuth(reason)` at the top. If the user is not signed in, this shows a `modal-require-auth` dialog (in `index.html`) with the `reason` string and two buttons — **Go back** (returns `false`, caller bails) and **Sign in with Google** (triggers the Firebase Google popup, returns `true` on success). The underlying helper is `_openAuthRequiredDialog(reason)` which returns a Promise.

Reasons passed per action:
- Create/manage sessions → "Sign in to create or manage sessions"
- Resume draft → "Sign in to resume your session"
- Join session → "Sign in to join a session"
- Add bhajan → "Sign in to add bhajans"
- Claim host → "Sign in to claim host"
- Edit mode → "Sign in to edit the session"
- Toggle favourite → "Sign in to save favourites"

## Persistence flow

1. Local draft → `localStorage` (key: `bm-draft-session`)
2. Completed sessions → `localStorage` cache (key: `bm-sessions-v2`) + `data/sessions.json` committed to GitHub via `GitHubStore` (requires a PAT stored in localStorage)
3. Live sync → Firebase Realtime DB (host writes, observers read)

## Session management — key rules and constraints

### Session identity
`id` and `roomCode` are both set to `_sessionRoomCode(series, date)` → `seriesslug-YYYY-MM-DD`. The slug is `series.toLowerCase().replace(/[^a-z0-9]/g,'')`. Same series + same date always produces the same ID; creating a duplicate is blocked with a redirect to the existing session.

### Multiple sessions per series
- **Same series, same date**: hard-blocked (deterministic ID collision).
- **Same series, different dates**: fully allowed — no limit. Each session gets its own Firebase node and its own row in `data/sessions.json`.

### Session form date constraints
- Default: today's date.
- **Setup/live sessions** (`isBackdated = false`): future dates are allowed — the setup phase is specifically designed for preparing upcoming sessions in advance (e.g. next Sunday's bhajan). No `max` constraint is set on the date input.
- **Backdated sessions**: any past date is valid (opens directly in edit mode; saved as `status: 'completed'` immediately).

### Single active session per browser
`this.liveState` and `this.live` are singletons — only one session can be actively hosted at a time. Starting a new session while one is active automatically backgrounds the running session (with a confirmation prompt) before opening the new session form.

### Background sessions
`_bgSessions` (localStorage key `mm-bg-sessions`) is an array of `{roomCode, label, series, date, isHost, snapshot?}`. Multiple sessions from different series can be backgrounded simultaneously. They appear in the Session view's **My Sessions** section. Capped at 10 entries (oldest dropped on overflow). Sessions whose `date` is more than 2 days old (or have no date) are auto-expired and their Firebase nodes cleaned up (`_cleanupExpiredBgSessions()`). The Live Now probe covers yesterday through +6 days, so a backgrounded session stays discoverable by observers within that window.

**Entry fields:**
- `roomCode` — Firebase node key, used as the session identifier.
- `label` — display name.
- `series`, `date` — metadata; `date` is always set (falls back to today when not known).
- `isHost` — `true` if this device hosted the session; `false` for observer bookmarks.
- `snapshot` — copy of `liveState` at the moment of backgrounding; used to seed the UI on Resume before Firebase replies.

**Observer bookmarks**: When an observer makes a live edit (`_applyLiveEdit()`), `_saveObserverBookmark()` records a `{isHost: false}` entry in `_bgSessions`. This lets observers rejoin their sessions from My Sessions without having hosted them.

**Host vs observer on discard**: `_discardBgSession()` only calls `LiveSession.cleanupOrphan()` when `entry.isHost !== false`. Observers use `_leaveBgSession()` instead, which removes the entry without touching Firebase.

**Badge**: `_updateBgBadge()` keeps the bottom-nav Session tab count badge in sync. Called automatically by `_saveBgSessions()` and once on app init.

### Session lifecycle
| Phase | `status` (stored) | `phase` (Firebase) | Stored to sessions? |
|---|---|---|---|
| Newly created (live) | `'live'` | `'setup'` | Draft only |
| Playing | `'live'` | `'playing'` | Draft only |
| Ended normally | `'completed'` | `'ended'` | Yes — `sessions.save()` |
| Backdated at creation | `'completed'` | — | Yes — `sessions.save()` |
| Discarded | _(deleted)_ | _(Firebase cleaned)_ | Never |

`data/sessions.json` and localStorage cache (`bm-sessions-v2`) only ever receive `status: 'completed'` sessions. A session in the draft (`bm-draft-session`) has `status: 'live'` and is not yet in the permanent store.

### Host vs observer
- **Host**: set by calling `live.host()`. Has exclusive control over Start/End/Discard/Background buttons and wake-lock. Writes all state changes to Firebase.
- **Observer**: set by calling `live.join()`. Can add bhajans (setup phase only) and edit pitch/singers in edit mode. Can call `claimHost()` to take over (behind auth gate). Appears in My Sessions under a "Joined" badge (not "Observer") with **Rejoin** and **Leave** buttons.
- Firebase rules do not enforce host/observer roles at the transport layer — gating is UI-only in app.js.

### My Sessions card variants
Three visually distinct card types in `_sessionHomeHTML()`:
1. **Draft (not started)** — shows "Draft — not started" eyebrow, left accent bar via `.own-session-draft-card`. Buttons: Resume, Discard.
2. **Host backgrounded** — shows "Host" badge, normal card. Buttons: Resume, Discard.
3. **Observer bookmark** — shows "Joined" badge, left accent via `.own-session-observer-card`. Buttons: Rejoin, Leave.

### Confirm dialog
`_confirm(title, body, confirmLabel, { danger })` — styled `Promise<boolean>` dialog using `#modal-confirm`. Replaces all native `window.confirm()` calls throughout app.js. The cancel button, close (✕), and overlay backdrop all resolve `false`; OK resolves `true`. Danger variant uses `btn-danger` on the confirm button.

### Series storage (four sources merged)
1. `mm-local-series` localStorage — series names created via "+ New Series" modal, device-local.
2. `bm-sessions-v2` localStorage — unique `series` values from completed sessions via `knownSeries()`.
3. `data/series.json` in the GitHub repo — committed by `GitHubStore._commitSeriesIndex()` after each sync.
4. `data/series/<slug>.json` per-series files — sessions for that series only; not directly fetched by the app at runtime.

`_fetchKnownSeries()` merges all four **plus** the active `liveState.series` and any draft's series, ensuring a brand-new series is always present in the join modal even before it's been committed anywhere.

### Slug divergence (intentional)
`_seriesSlug(name)` strips all non-alphanumeric characters (e.g. `"Thursday Satsang"` → `"thursdaysatsang"`). This is used in **Firebase room codes** (`thursdaysatsang-2026-08-17`).

`GitHubStore._slugify(name)` replaces non-alphanumeric characters with hyphens (e.g. `"Thursday Satsang"` → `"thursday-satsang"`). This is used in **GitHub file paths** (`data/series/thursday-satsang.json`).

The two slugs serve different namespaces and must never be derived from each other.
