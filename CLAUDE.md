# Melody Miracle — Codebase Context

## What this is

A **vanilla JS PWA** for managing bhajan (devotional song) sessions. No framework, no build step — plain HTML5, CSS, and ES modules. Works offline via a service worker and syncs sessions to GitHub as a JSON file.

## Architecture at a glance

```
index.html          Single-page shell; all views declared here as hidden divs
js/app.js           Main controller (~4 350 lines) — routing, rendering, all UI logic
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

1. Local draft → `localStorage` (key: `bm-draft`)
2. Completed sessions → `localStorage` cache (key: `bm-sessions-v2`) + `data/sessions.json` committed to GitHub via `GitHubStore` (requires a PAT stored in localStorage)
3. Live sync → Firebase Realtime DB (host writes, observers read)
