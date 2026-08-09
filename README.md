# Melody Miracle

A Progressive Web App for managing bhajan (devotional song) sessions. Built for Sai bhajan groups — record which bhajans are sung, by whom, at what pitch, track session history, and coordinate live sessions across multiple devices in real time.

## Features

- **Live session hosting** — start a session and share it; others join instantly using the series & date
- **Real-time sync** — Firebase Realtime Database keeps all participants in sync as bhajans are added
- **Bhajan catalog** — ~1 450 bhajans with deity, raga, beat, tempo, pitch, lyrics, and audio links
- **Deity tracking** — every bhajan is tagged by deity; session headers show a colour-coded deity summary so singers can pick variety
- **Pitch guidance** — gents/ladies pitch in Indian (Pancham/Madhyam) and Western notation
- **Session history** — completed sessions committed to GitHub as `data/sessions.json`; browse by date, series, or singer
- **Singer profiles** — per-singer stats: session count, bhajan count, deity distribution, usual pitch
- **Offline-first** — service worker caches the app shell; only data files (bhajans, sessions) need the network
- **Installable PWA** — add to home screen on iOS/Android; works like a native app

## Tech stack

Vanilla JS · No framework · No build step · ES modules · Firebase (Realtime DB + Auth) · GitHub Contents API · Service Worker

## Getting started

Open `index.html` in a browser (or serve the directory with any static server). No build step required.

```
npx serve .
# or
python3 -m http.server
```

Sign in with Google (top-right) to enable favourites and host live sessions.

To sync completed sessions to GitHub, enter a [GitHub PAT](https://github.com/settings/tokens) with `contents: write` scope in **Settings → GitHub Token**.

## Adding bhajans

1. Create or edit a Markdown file in `bhajans/` — see any existing file for the front-matter schema.
2. Run the build script:
   ```
   python scripts/build-bhajans.py
   ```
   This regenerates `data/bhajans.json`.
3. Commit both the `.md` file and the updated `data/bhajans.json`.

## Project layout

```
index.html          App shell (all views as hidden divs)
js/app.js           Main controller — routing, rendering, all UI logic
js/store.js         BhajanStore + SessionStore
js/github-store.js  Commits sessions.json to GitHub via PAT
js/live.js          Firebase live-session sync
js/auth.js          Google Auth via Firebase
js/favourites.js    Per-user favourites in Firebase
css/style.css       All styles
data/bhajans.json   Generated bhajan catalog (do not edit manually)
data/sessions.json  Committed session history
bhajans/            Markdown source files, one per bhajan
scripts/            Python data-pipeline scripts
sw.js               Service worker (cache-first shell, network-first data)
```

## Deity colour system

Bhajans are grouped by deity and displayed with colour-coded pills:

| Deity | Slug | Colour |
|---|---|---|
| Ganesha / Ganapati | `ganesha` | Amber |
| Shiva / Mahadeva | `shiva` | Indigo |
| Vishnu / Narayana | `vishnu` | Emerald |
| Devi / Durga / Lakshmi | `devi` | Pink |
| Rama | `rama` | Green |
| Krishna / Govinda | `krishna` | Violet |
| Hanuman / Anjaneya | `hanuman` | Orange |
| Murugan / Subrahmanya | `murugan` | Yellow |
| Ayyappa | `ayyappa` | Light green |
| Everything else | `other` | Muted |

The **Ganesha-first convention** is enforced: a dashed placeholder appears at position 1 until a Ganesha bhajan is added.

## Deployment

The app is a static site — deploy the repository root to any static host (GitHub Pages, Netlify, Vercel, etc.).

After changing `js/app.js` or `css/style.css`, bump the version strings so the service worker refreshes all clients:

1. Increment `V_APP` and/or `V_CSS` in `sw.js` (format: `YYYYMMDD.N`).
2. Bump `CACHE` to the same value.
3. Update the matching `?v=` query strings in `index.html`.

## Firebase setup

The app uses the `melody-miracle` Firebase project (`asia-southeast1`). To run your own instance, replace the Firebase config object near the top of `js/auth.js` and `js/live.js`, and update the Realtime Database paths accordingly.
