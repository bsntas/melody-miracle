#!/usr/bin/env python3
"""Parse all bhajan markdown files and generate data/bhajans.json."""

import os
import re
import json
import sys


# ## Audio section headings -> track type (see fetch-sairhythms.py)
TRACK_KINDS = {'Audio': 'main', "Swami's Voice": 'golden', 'Instrumental': 'instrumental',
               'Tutorial': 'tutorial', 'Karaoke': 'karaoke'}


# Song type, from Sai Rhythms' song tags plus title keywords (the site's tagging
# is incomplete — e.g. several ashtakams/mantras carry no "Prayers" tag).
# bhajan | prayer (stotrams, mantras, ashtakams, suprabhatham) | arathi | kriti | carol | song
ALBUM_TAGS = {'Abhayankara Sai', 'Ageless One', "Flyin' Free", 'Heart Voice', 'I Keep Feeling',
              'Living Love', 'Love To Love', 'My Light Never Dims', 'My Sweet', 'Now And Forever',
              'O Holy Presence', 'Reveal Yourself', 'Ribbons Of Light', 'Sai Of Love',
              'Second Coming', 'Solar Love'}
PRAYER_TAGS = {'Prayers', 'Suprabhatham', '108', 'Food'}
PRAYER_TITLE = re.compile(r'sto?th?ram|ashtak|ashto?th?ram|suprabha|\bmantr', re.I)
ARATHI_TITLE = re.compile(r'^(mangala\s+)?aa?rat(h)?i$', re.I)


def song_type(title, tags):
    tags = set(tags or [])
    if 'Kritis' in tags:
        return 'kriti'
    if 'Carols' in tags:
        return 'carol'
    if 'Arathi' in tags or ARATHI_TITLE.match(title or ''):
        return 'arathi'
    if tags & PRAYER_TAGS or PRAYER_TITLE.search(title or ''):
        return 'prayer'
    if tags & ALBUM_TAGS:
        return 'song'
    return 'bhajan'


def clean_pitch(raw):
    """Extract just the pitch value (e.g., '2 Pancham / D') from raw field."""
    if not raw:
        return None
    raw = raw.strip()
    # Match patterns like "1 Pancham / C", "2.5 Madhyam / G#", "2.5 Pancham / E Flat"
    m = re.match(r'^(\d+\.?\d*\s+\w+)\s*/\s*([A-G])(#|♭|b|\s*Flat|\s*Sharp)?', raw)
    if m:
        note, acc = m.group(2), (m.group(3) or '').strip()
        if acc in ('#', 'Sharp'):
            note += '#'
        elif acc in ('♭', 'b', 'Flat'):
            # The app's pitch vocabulary uses sharps only (E♭ → D#, B♭ → A#)
            note = {'C': 'B', 'D': 'C#', 'E': 'D#', 'F': 'E', 'G': 'F#', 'A': 'G#', 'B': 'A#'}[note]
        return f'{m.group(1)} / {note}'
    # Match just a note or number as fallback
    return raw[:40].strip()


def parse_bhajan(filepath):
    with open(filepath, encoding='utf-8') as f:
        content = f.read()

    filename = os.path.basename(filepath)
    bhajan_id = filename[:-3]  # strip .md

    # Title
    m = re.search(r'^# (.+)$', content, re.MULTILINE)
    title = m.group(1).strip() if m else bhajan_id.replace('-', ' ').title()

    # Source URL
    m = re.search(r'\[Sai Rhythms\]\(([^)]+)\)', content)
    source_url = m.group(1) if m else None

    # Audio — "- **Kind** (caption): [▶ Listen](url)" lines, or the older single
    # "[▶ Listen](url)" line, in the ## Audio section
    audio_tracks = []
    m = re.search(r'## Audio\r?\n\r?\n(.*?)(?=\r?\n## |\r?\n---|\Z)', content, re.DOTALL)
    for line in (m.group(1).splitlines() if m else []):
        t = re.match(r'^- \*\*(.+?)\*\*(?: \((.*)\))?: \[▶ Listen\]\((\S+)\)$', line.strip())
        if t and t.group(1) in TRACK_KINDS:
            audio_tracks.append({'type': TRACK_KINDS[t.group(1)], 'label': t.group(2) or '', 'url': t.group(3)})
            continue
        t = re.match(r'^\[▶ Listen\]\((\S+)\)$', line.strip())
        if t:
            audio_tracks.append({'type': 'main', 'label': '', 'url': t.group(1)})
    audio_url = next((t['url'] for t in audio_tracks if t['type'] == 'main'), None)

    # Details table fields
    def get_field(field_name):
        pattern = rf'\|\s*\*\*{re.escape(field_name)}\*\*\s*\|\s*([^|]+)\s*\|'
        m = re.search(pattern, content)
        return m.group(1).strip() if m else None

    # Sai Rhythms song tags, e.g. "Prayers, Vintage"
    tags = [t.strip() for t in (get_field('Tags') or '').split(',') if t.strip()]

    # Lyrics section
    m = re.search(r'## Lyrics\n\n(.*?)(?=\n## |\Z)', content, re.DOTALL)
    lyrics = m.group(1).strip() if m else None

    # Meaning section
    m = re.search(r'## Meaning\n\n(.*?)(?=\n## |\Z)', content, re.DOTALL)
    meaning = m.group(1).strip() if m else None

    return {
        'id': bhajan_id,
        'title': title,
        'deity': get_field('Deity'),
        'language': get_field('Language'),
        'raga': get_field('Raga'),
        'beat': get_field('Beat'),
        'tempo': get_field('Tempo'),
        'level': get_field('Level'),
        'gents_pitch': clean_pitch(get_field('Gents Pitch')),
        'ladies_pitch': clean_pitch(get_field('Ladies Pitch')),
        'lyrics': lyrics,
        'meaning': meaning,
        'audio_url': audio_url,
        'audio_tracks': audio_tracks,
        'tags': tags,
        'type': song_type(title, tags),
        'source_url': source_url,
    }


def main():
    # Run from repo root
    bhajans_dir = 'bhajans'
    if not os.path.isdir(bhajans_dir):
        print(f'Error: {bhajans_dir}/ not found. Run from repo root.', file=sys.stderr)
        sys.exit(1)

    os.makedirs('data', exist_ok=True)

    files = sorted(f for f in os.listdir(bhajans_dir) if f.endswith('.md'))
    bhajans = []
    errors = []

    for filename in files:
        filepath = os.path.join(bhajans_dir, filename)
        try:
            bhajan = parse_bhajan(filepath)
            bhajans.append(bhajan)
        except Exception as e:
            errors.append(f'{filename}: {e}')

    # Sort by title (case-insensitive)
    bhajans.sort(key=lambda b: b['title'].lower())

    output_path = 'data/bhajans.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(bhajans, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(output_path) / 1024
    print(f'Generated {len(bhajans)} bhajans → {output_path} ({size_kb:.0f} KB)')

    if errors:
        print(f'\n{len(errors)} errors:')
        for e in errors:
            print(f'  {e}')


if __name__ == '__main__':
    main()
