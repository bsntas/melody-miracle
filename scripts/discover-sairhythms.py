#!/usr/bin/env python3
"""Walk sairhythms.sathyasai.org node IDs and list every song slug.

The site has no public song index or sitemap, so this requests /node/<n> for
each n and reads just the first few KB of the page to get its canonical URL.
Results are appended to a TSV (node, slug) so the walk can be resumed.

Usage (from repo root):
    python scripts/discover-sairhythms.py [--out nodes.tsv] [--start 1] [--end 13000]

Then list the slugs we don't have yet and fetch them:
    python scripts/discover-sairhythms.py --missing > missing.txt
    python scripts/fetch-sairhythms.py --file missing.txt
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://sairhythms.sathyasai.org'
UA = 'melody-miracle-bhajan-sync/1.0'
NON_SONG = {'glossary', 'tags', 'slides', 'signup', 'submit-new-song'}


def canonical(n):
    req = urllib.request.Request(f'{BASE}/node/{n}', headers={'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            head = r.read(4096).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        return e.code, None
    m = re.search(r'<link rel="canonical" href="([^"]+)"', head)
    return 200, (m.group(1) if m else None)


def song_slug(path):
    m = re.fullmatch(r'/song/([^/]+)', path or '')
    return urllib.parse.unquote(m.group(1)) if m and m.group(1) not in NON_SONG else None


def local_id(slug):
    return re.sub(r'-{2,}', '-', re.sub(r'[^a-z0-9-]', '', slug.lower())).strip('-')


def known_ids():
    ids = {f[:-3] for f in os.listdir('bhajans') if f.endswith('.md')}
    with open('data/bhajans.json', encoding='utf-8') as f:
        for b in json.load(f):
            ids.add(b['id'])
            m = re.search(r'/song/([^/?#]+)', b.get('source_url') or '')
            if m:
                ids.add(urllib.parse.unquote(m.group(1)))
    return ids


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='sairhythms-nodes.tsv')
    ap.add_argument('--start', type=int, default=1)
    ap.add_argument('--end', type=int, default=13000)
    ap.add_argument('--delay', type=float, default=1.0)
    ap.add_argument('--missing', action='store_true',
                    help='print song slugs from --out that are not in the catalog')
    a = ap.parse_args()

    done = {}
    if os.path.exists(a.out):
        with open(a.out, encoding='utf-8') as f:
            for line in f:
                n, _, path = line.rstrip('\n').partition('\t')
                done[int(n)] = path

    if a.missing:
        have = known_ids()
        slugs = sorted(s for s in {song_slug(p) for p in done.values()} - {None}
                       if s not in have and local_id(s) not in have)
        print('\n'.join(slugs))
        print(f'{len(slugs)} missing', file=sys.stderr)
        return

    with open(a.out, 'a', encoding='utf-8') as out:
        for n in range(a.start, a.end + 1):
            if n in done:
                continue
            for attempt in range(4):
                try:
                    code, path = canonical(n)
                    break
                except Exception as e:
                    print(f'node {n}: {e} (retry {attempt + 1})', file=sys.stderr)
                    time.sleep(5 * (attempt + 1))
            else:
                continue  # leave unrecorded so a re-run retries it
            out.write(f'{n}\t{path or code}\n')
            out.flush()
            if n % 250 == 0:
                print(f'… node {n}', file=sys.stderr, flush=True)
            time.sleep(a.delay)


if __name__ == '__main__':
    main()
