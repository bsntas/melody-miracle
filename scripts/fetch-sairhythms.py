#!/usr/bin/env python3
"""Fetch bhajans from sairhythms.sathyasai.org into bhajans/<slug>.md.

Usage (from repo root):
    python scripts/fetch-sairhythms.py <slug-or-url> [<slug-or-url> ...]
    python scripts/fetch-sairhythms.py --file slugs.txt   # one slug/URL per line

Existing files are skipped unless --force is given. Newly written bhajans are
merged into data/bhajans.json (existing entries are kept untouched — a full
build-bhajans.py rebuild would drop catalog entries that have no .md file).
Pitch split and scale are filled in for the new entries.
"""

import html
import importlib.util
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

BASE = 'https://sairhythms.sathyasai.org'
UA = 'melody-miracle-bhajan-sync/1.0'
DELAY = 1.0  # seconds between requests — be polite to the site


def slug_of(arg):
    arg = arg.strip().rstrip('/')
    m = re.search(r'/song/([^/?#]+)', arg)
    return urllib.parse.unquote(m.group(1) if m else arg)


def local_id(slug):
    """ASCII-only id/filename (site slugs can contain e.g. curly apostrophes)."""
    return re.sub(r'-{2,}', '-', re.sub(r'[^a-z0-9-]', '', slug.lower())).strip('-')


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode('utf-8', 'replace')


def text(fragment):
    fragment = re.sub(r'<br\s*/?>', '\n', fragment)
    fragment = re.sub(r'<[^>]+>', '', fragment)
    return html.unescape(fragment).replace('\xa0', ' ').strip()


def meta_field(page, label):
    m = re.search(
        r"<div class='col[^']*strong'>\s*" + re.escape(label) +
        r"\s*</div><div class='col[^']*'>(.*?)</div></div>", page, re.S)
    return text(m.group(1)) if m else None


AUDIO_ROW_RE = re.compile(
    r"<div class='row devotional-song-meta-data-grid [\w-]+'>\s*"
    r"<div class='col[^']*strong'>\s*(.*?)\s*</div>"
    r"(.*?)(?=<div class='row devotional-song-meta-data-grid|\Z)", re.S)

# Sai Rhythms audio row label -> track type, and the heading used in the .md files
TRACK_TYPES = {'Audio': 'main', 'Golden Voice': 'golden', 'Instrumental': 'instrumental',
               'Tutorial': 'tutorial', 'Karaoke Tracks for Practice': 'karaoke'}
TRACK_HEADINGS = {'main': 'Audio', 'golden': "Swami's Voice", 'instrumental': 'Instrumental',
                  'tutorial': 'Tutorial', 'karaoke': 'Karaoke'}


def make_track(row_label, url, caption=''):
    """{type, label, url} for one recording, or None for rows we don't know."""
    kind = TRACK_TYPES.get(row_label)
    if not kind:
        return None
    caption = re.sub(r'\s*Karaoke Tracks?\b', '', caption or '').strip()
    return {'type': kind, 'label': caption, 'url': url}


def audio_tracks(page):
    """Every recording in the page's labelled audio rows, in page order.
    Each track's caption is the text just before its player, e.g.
    "Reference Track 1 Madhyam / F" on karaoke rows."""
    tracks, seen = [], set()
    for label, body in AUDIO_ROW_RE.findall(page):
        label, pos = text(label), 0
        for m in re.finditer(r"""<source src=['"]([^'"]+\.mp3)""", body):
            cap = re.sub(r"<a [^>]*>[^<]*\.mp3\s*</a>", ' ', body[pos:m.start()])
            pos = body.find('>', m.end()) + 1 or m.end()
            url = urllib.parse.urljoin(BASE + '/', m.group(1))
            t = make_track(label, url, re.sub(r'\s+', ' ', text(re.sub(r'<[^>]+>', ' ', cap))))
            if t and url not in seen:
                seen.add(url); tracks.append(t)
    order = list(TRACK_HEADINGS)   # main recording first, then Swami's Voice, …
    return sorted(tracks, key=lambda t: order.index(t['type']))


# Tags that describe the recordings rather than the song (covered by audio tracks)
MEDIA_TAGS = {'golden voice', 'instrumental', 'karaoke', 'lead-music', 'sheet-music', 'tutorial'}


def song_tags(page):
    """Song tags from the page's "Song Tags" row, e.g. ['Prayers', 'Vintage']."""
    m = re.search(r"song-tags-row'>(.*?)(?=<div class='row devotional-song-meta-data-grid|\Z)", page, re.S)
    if not m:
        return []
    names = [text(t) for t in re.findall(r"<a [^>]*href=['\"][^'\"]*/tags/[^'\"]*['\"][^>]*>(.*?)</a>", m.group(1), re.S)]
    return [n for n in dict.fromkeys(names) if n and n.lower() not in MEDIA_TAGS]


def tracks_markdown(tracks):
    """Lines for the .md "## Audio" section (read back by build-bhajans.py)."""
    out = []
    for t in tracks:
        cap = f" ({t['label']})" if t['label'] else ''
        out.append(f"- **{TRACK_HEADINGS[t['type']]}**{cap}: [▶ Listen]({t['url']})")
    return out


def parse(page, slug):
    m = re.search(r"<div class='song-first-line'>.*?</div>\s*</div>", page, re.S)
    if not m:
        return None
    lines = re.findall(r"<div class='song-(?:first-)?line'>(.*?)</div>", m.group(0), re.S)
    lyrics = [text(l) for l in lines if text(l)]
    title = lyrics[0] if lyrics else slug.replace('-', ' ').title()
    t = re.search(r'<title>(.*?) \| Sai Rhythms</title>', page)
    if t:
        title = html.unescape(t.group(1)).strip()

    m = re.search(r"<div class='devotional-song-meaning[^']*'>(.*?)</div>", page, re.S)
    meaning = text(m.group(1)) if m else None

    raga = None
    raga_notes = None
    m = re.search(r"<div class='raga-title'>(.*?)</div>", page, re.S)
    if m:
        raga = text(m.group(1))
        n = re.search(r"raga-notes-panel'[^>]*>(.*?)</div></div></div>", page, re.S)
        if n:
            raga_notes = re.sub(r' {2,}', ' ', text(n.group(1)))
    else:
        raga = meta_field(page, 'Raga')

    tracks = audio_tracks(page)
    tags = song_tags(page)

    return {
        'title': title,
        'deity': meta_field(page, 'Deity'),
        'language': meta_field(page, 'Language'),
        'raga': raga,
        'raga_notes': raga_notes,
        'beat': meta_field(page, 'Beat'),
        'tempo': meta_field(page, 'Tempo'),
        'level': meta_field(page, 'Level'),
        'gents': meta_field(page, 'Reference Gents Pitch'),
        'ladies': meta_field(page, 'Reference Ladies Pitch'),
        'lyrics': lyrics,
        'meaning': meaning,
        'tracks': tracks,
        'tags': ', '.join(tags),
    }


def to_markdown(b, slug):
    out = [f"# {b['title']}", '',
           f"> **Source:** [Sai Rhythms]({BASE}/song/{urllib.parse.quote(slug)})", '',
           '## Details', '', '| Field | Value |', '|---|---|']
    for label, key in [('Deity', 'deity'), ('Language', 'language'), ('Raga', 'raga'),
                       ('Beat', 'beat'), ('Tempo', 'tempo'), ('Level', 'level'),
                       ('Gents Pitch', 'gents'), ('Ladies Pitch', 'ladies'), ('Tags', 'tags')]:
        if b[key]:
            out.append(f"| **{label}** | {b[key]} |")
    out.append('')
    if b['raga_notes']:
        out += ['### Raga Notes', '', '```', b['raga_notes'], '```', '']
    out += ['## Lyrics', '', *b['lyrics'], '']
    if b['meaning']:
        out += ['## Meaning', '', b['meaning'], '']
    if b['tracks']:
        out += ['## Audio', '', *tracks_markdown(b['tracks']), '']
    out += ['---', '',
            f"*Scraped from [sairhythms.sathyasai.org]({BASE}) — Sri Sathya Sai International Organization*"]
    return '\n'.join(out)


def _load_script(name):
    spec = importlib.util.spec_from_file_location(
        name.replace('-', '_'), os.path.join(os.path.dirname(__file__), name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def merge_into_catalog(slugs, catalog='data/bhajans.json'):
    """Add/replace only the given bhajans in the catalog. Other entries (incl.
    hand-corrected ones and JSON-only ones) and their order are left as-is."""
    build = _load_script('build-bhajans')
    pitch = _load_script('add-pitch-scale')
    with open(catalog, encoding='utf-8') as f:
        data = json.load(f)
    for slug in slugs:
        b = build.parse_bhajan(os.path.join('bhajans', slug + '.md'))
        b['gents_pitch_indian'], b['gents_pitch_western'] = pitch.split_pitch(b['gents_pitch'])
        b['ladies_pitch_indian'], b['ladies_pitch_western'] = pitch.split_pitch(b['ladies_pitch'])
        b['scale'] = pitch.get_scale(b['raga'])
        idx = next((i for i, x in enumerate(data) if x['id'] == slug), None)
        if idx is not None:
            data[idx] = b
        else:
            key = b['title'].lower()
            pos = next((i for i, x in enumerate(data) if x['title'].lower() > key), len(data))
            data.insert(pos, b)
    with open(catalog, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f'Merged {len(slugs)} into {catalog} ({len(data)} bhajans)')


def main(argv):
    force = '--force' in argv
    argv = [a for a in argv if a != '--force']
    if argv[:1] == ['--file']:
        with open(argv[1], encoding='utf-8') as f:
            argv = [l.strip(' \t\r') for l in f.read().split('\n') if l.strip()]
    if not argv:
        print(__doc__)
        return 1
    os.makedirs('bhajans', exist_ok=True)
    added, skipped, failed = [], [], []
    for i, arg in enumerate(argv):
        slug = slug_of(arg)
        bid = local_id(slug)
        path = os.path.join('bhajans', bid + '.md')
        if os.path.exists(path) and not force:
            skipped.append(slug)
            continue
        if i:
            time.sleep(DELAY)
        try:
            b = parse(fetch(f'{BASE}/song/{urllib.parse.quote(slug)}'), slug)
        except Exception as e:
            failed.append(f'{slug}: {e}')
            continue
        if not b:
            failed.append(f'{slug}: no lyrics found')
            continue
        with open(path, 'w', encoding='utf-8') as f:
            f.write(to_markdown(b, slug))
        added.append(bid)
        print(f'+ {slug}  ({b["deity"]})')
    print(f'\nAdded {len(added)}, skipped {len(skipped)} existing, failed {len(failed)}')
    for f in failed:
        print('  !', f)
    if added:
        merge_into_catalog(added)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
