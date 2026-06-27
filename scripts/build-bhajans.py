#!/usr/bin/env python3
"""Parse all bhajan markdown files and generate data/bhajans.json."""

import os
import re
import json
import sys


def clean_pitch(raw):
    """Extract just the pitch value (e.g., '2 Pancham / D') from raw field."""
    if not raw:
        return None
    raw = raw.strip()
    # Match patterns like "1 Pancham / C", "2.5 Madhyam / G#"
    m = re.match(r'^(\d+\.?\d*\s+\w+\s*/\s*[A-G][#♭b]?)', raw)
    if m:
        return m.group(1).strip()
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

    # Audio URL
    m = re.search(r'\[▶ Listen\]\(([^)]+)\)', content)
    audio_url = m.group(1) if m else None

    # Details table fields
    def get_field(field_name):
        pattern = rf'\|\s*\*\*{re.escape(field_name)}\*\*\s*\|\s*([^|]+)\s*\|'
        m = re.search(pattern, content)
        return m.group(1).strip() if m else None

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
