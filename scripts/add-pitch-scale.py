#!/usr/bin/env python3
"""
Transform data/bhajans.json:
  - Split gents_pitch / ladies_pitch into _indian and _western sub-fields
  - Fix incorrect western label "B" → "A#" for the two pitch positions that
    map to A# (4 Madhyam and 6.5 Pancham)
  - Add `scale` field ("Major" | "Minor" | "Mixed") derived from raga name
"""

import json, re, sys
from pathlib import Path

# ── Pitch parser ──────────────────────────────────────────────────────────────

PITCH_RE = re.compile(r'^([\d.]+)\s+(Madhyam|Pancham)\s*(?:/\s*(.+))?$', re.IGNORECASE)

NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
# Semitones above C for each Pancham position; Madhyam is a fourth (5) higher
POSITION = {'1': 0, '1.5': 1, '2': 2, '2.5': 3, '3': 4, '4': 5,
            '4.5': 6, '5': 7, '5.5': 8, '6': 9, '6.5': 10, '7': 11}

def split_pitch(raw):
    """Return (indian, western) from "X Pancham / Y" or similar.

    The western note is derived from the Indian position (the source labels
    were unreliable: "E Flat" was truncated to "E", "B Flat" to "B")."""
    if not raw:
        return '', ''
    m = PITCH_RE.match(raw.strip())
    if not m or m.group(1) not in POSITION:
        return raw.strip(), ''
    series = m.group(2).capitalize()
    indian = f'{m.group(1)} {series}'
    western = NOTES[(POSITION[m.group(1)] + (5 if series == 'Madhyam' else 0)) % 12]
    return indian, western

# ── Raga → scale mapping ──────────────────────────────────────────────────────
# Classification is by the third (Ga) alone, since that decides the chord
# (C vs Cm) an accompanist plays:
#                 Major = shuddha Ga only
#                 Minor = komal Ga only
#                 Mixed = both Ga variants
# Ragas with no Ga at all are classified by ear/convention.
# Verified against the "In the Key of C" note lists on Sai Rhythms.

SCALE_MAP = {
    # ── Explicitly labelled ──
    'Major (Gavati)':                     'Major',
    'Major (Hamsadhwani)':               'Major',
    'Major (Harikamboji)':               'Major',
    'Major (Mohanam / Bhoop)':           'Major',
    'Major (Pahadi)':                    'Major',
    'Major (Shankarabharanam / Bilawal)': 'Major',
    'Major (Yaman Kalyan)':              'Major',
    'Minor (Bilaskhani Todi)':           'Minor',
    'Minor (Natabhairavi)':              'Minor',
    'Minor (Sindhu Bhairavi / Bhairavi)': 'Minor',
    'Minor (~ Natabhairavi)':            'Minor',
    'Harmonic Minor':                    'Minor',

    # ── Major ragas ──
    'Aarabhi':                           'Major',   # Harikamboji janya, shuddha Ga
    'Atana':                             'Major',   # Harikamboji janya
    'Bihag':                             'Major',   # Bilaval thaat, shuddha Ga + Ni
    'Bilahari':                          'Major',   # Shankarabharanam janya
    'Bowli':                             'Major',   # Shankarabharanam janya
    'Brindavan Sarang':                  'Major',   # Bilaval thaat
    'Desh':                              'Major',   # Khamaj thaat, shuddha Ga
    'Gara':                              'Mixed',   # Khamaj thaat — uses both Ga
    'Gavati':                            'Major',   # Shankarabharanam janya
    'Hamir Kalyani / Kedar':             'Major',   # Kalyani janya + Bilaval thaat
    'Hamsa Vahini':                      'Major',   # Shankarabharanam janya
    'Hamsadhwani':                       'Major',   # Sa Re Ga Pa Ni — major pentatonic
    'Hamsanadam':                        'Major',   # Major pentatonic variant
    'Hamsavinodini':                     'Major',   # Major feel
    'Harikamboji':                       'Major',   # 28th mela, shuddha Ga (Khamaj)
    'Kalyana Vasantham':                 'Minor',   # 21st mela janya — Komal Ga
    'Kalyani / Yaman':                   'Major',   # 65th mela, Lydian/Yaman — all major
    'Khamaj':                            'Major',   # Shuddha Ga, komal Ni (dominant)
    'Khamas':                            'Major',   # Harikamboji janya
    'Maand':                             'Major',   # Khamaj/Bilaval based
    'Mohana Kalyani / Shuddha Kalyan':   'Major',   # Mohanam + Kalyani blend
    'Mohanam / Bhoop':                   'Major',   # Sa Re Ga Pa Dha — major pentatonic
    'Maru Bihag':                        'Major',   # Primarily Bilaval with shuddha Ga
    'Natakurinji':                       'Major',   # Harikamboji janya
    'Nattai':                            'Major',   # Shuddha Ga (the E♭ in its scale is R3, not a komal Ga)
    'Pahadi':                            'Major',   # Khamaj thaat, shuddha Ga
    'Sama':                              'Major',   # Harikamboji janya, pentatonic
    'Saraswathi':                        'Major',   # Shuddha Ga (28th mela variant)
    'Senjurutti / Jhinjhoti':            'Major',   # Khamaj thaat
    'Shankara':                          'Major',   # Shankarabharanam janya
    'Shankarabharanam / Bilawal':        'Major',   # The natural major scale
    'Shuddha Sarang':                    'Major',   # Major feel
    'Shuddha Saveri / Durga':            'Major',   # Sa Re Ma Pa Dha — major pentatonic
    'Sunada Vinodini / Hindol':          'Major',   # Hindol: shuddha Ga (Sa Ga Ma# Dha Ni)
    'Surya':                             'Major',   # Major
    'Tilak Kamod':                       'Major',   # Bilaval thaat
    'Tilang':                            'Major',   # Khamaj thaat
    'Valaji / Kalavati':                 'Major',   # Bright pentatonic, major feel
    'Vasanthi / Prateeksha':             'Major',   # Shankarabharanam derivative
    'Yadukula Kamboji':                  'Major',   # Harikamboji janya
    'Yaman Kalyan':                      'Major',   # Kalyan thaat, Lydian

    # Mishra (mixed-context renditions that stay in the base raga's scale)
    'Mishra Gavati':                     'Major',
    'Mishra Gara':                       'Mixed',
    'Mishra Maand':                      'Major',
    'Mishra Pahadi':                     'Major',
    'Mishra Shankarabharanam / Bilawal': 'Major',
    'Mishra Surya':                      'Major',
    'Mishra Tilang':                     'Major',
    'Mishra Valaji / Kalavathi':         'Major',

    # ── Minor ragas ──
    'Abheri / Bhimpalas':               'Minor',   # Komal Ga, Komal Dha, Komal Ni
    'Abhogi':                           'Minor',   # Komal Ga, no Pa
    'Bageshri':                         'Minor',   # Komal Ga, Komal Ni
    'Bhavapriya':                       'Minor',   # 44th mela, Komal Ga
    'Chandrakauns':                     'Minor',   # Komal Ga, no Pa
    'Darbari':                          'Minor',   # Komal Ga, Komal Dha (dramatic)
    'Folk tune (Kavadi Sindhu)':        'Minor',   # Minor feel
    'Gowri Manohari / Patdeep':         'Minor',   # 23rd mela, Komal Ga
    'Hindolam / Malkauns':              'Minor',   # Sa Ga♭ Ma Dha♭ Ni♭
    'Jaunpuri':                         'Minor',   # Komal Ga, Komal Dha (Asavari thaat)
    'Kanada':                           'Minor',   # Komal Ga (complex vakra)
    'Karaharapriya / Kafi':             'Minor',   # 22nd mela — natural minor
    'Keeravani':                        'Minor',   # 21st mela — harmonic minor
    'Kuntalavarali':                    'Minor',   # 49th mela janya, Komal Ga
    'Madhyamavati / Madhmad Sarang':    'Minor',   # Komal Ga in descent
    'Malayamarutham':                   'Major',   # 16th mela janya — Shuddha Ga
    'Miyan ki Malhar':                  'Minor',   # Komal Ga, Komal Ni
    'Nadanamakriya':                    'Major',   # 15th mela janya — Shuddha Ga
    'Naga Gandhari':                    'Minor',   # Minor character
    'Natabhairavi':                     'Minor',   # 20th mela — natural minor
    'Panchamkauns / Jayanthashri':      'Minor',   # Komal Ga
    'Parameshwari':                     'Minor',   # 68th mela, Komal Ga
    'Punnagavarali':                    'Minor',   # 8th mela janya, Komal Ga
    'Rageshri':                         'Major',   # Khamaj thaat — Shuddha Ga, Komal Ni
    'Revagupti':                        'Major',   # Sa Re♭ Ga Pa Dha♭ — Shuddha Ga
    'Revathi / Bhairagi Bhairav':       'Minor',   # Komal Ga
    'Salaga Bhairavi':                  'Minor',   # Bhairavi thaat, Komal Ga
    'Saramathi':                        'Minor',   # Minor character
    'Shanmukhapriya':                   'Minor',   # 56th mela, Komal Ga
    'Shekara Chandrika / Gujari Todi':  'Minor',   # Todi-based, Komal Ga
    'Shivaranjani':                     'Minor',   # Komal Ga (Sa Re Ga♭ Pa Dha)
    'Shubha Pantuvarali / Miyan ki Todi': 'Minor', # Todi thaat, Komal Ga
    'Shuddha Dhanyasi':                 'Minor',   # Hanumatodi janya, Komal Ga
    'Simhendramadhyamam':               'Minor',   # 57th mela, Komal Ga
    'Sindhu Bhairavi / Bhairavi':       'Minor',   # Komal Ga (Bhairavi thaat)
    'Sriranjani':                       'Minor',   # Karaharapriya janya, Komal Ga
    'Sumanesa Ranjani / Madhukauns':    'Minor',   # Komal Ga
    'Suryakantham':                     'Major',   # 17th mela — Shuddha Ga
    'Todi - Carnatic':                  'Minor',   # 8th mela — Komal Ga, Komal Re
    'Vakulabharanam / Basant Mukhari':  'Major',   # 14th mela — Komal Re, Shuddha Ga, Komal Dha/Ni
    'Varali':                           'Minor',   # Komal Ga, Komal Re, Tivra Ma
    'Janasammohini':                    'Major',   # Shuddha Ga

    # Mishra minor
    'Mishra Abheri / Bhimpalas':        'Minor',
    'Mishra Bageshri':                  'Minor',
    'Mishra Chandrakauns':              'Minor',
    'Mishra Darbari':                   'Minor',
    'Mishra Gowri Manohari / Patdeep':  'Minor',
    'Mishra Hindolam / Malkauns':       'Minor',
    'Mishra Keeravani':                 'Minor',
    'Mishra Rageshri':                  'Major',
    'Mishra Shanmukhapriya':            'Minor',
    'Mishra Shekara Chandrika / Gujari Todi': 'Minor',
    'Mishra Shivaranjani':              'Minor',
    'Mishra Sindhu Bhairavi / Bhairavi': 'Minor',
    'Mishra Vakulabharanam / Basant Mukhari': 'Major',

    # ── Mixed ragas ──
    'Amruthavarshini':                  'Major',   # Sa Ga Ma# Pa Ni — Shuddha Ga
    'Basanth':                          'Major',   # Komal Re/Dha, Shuddha Ga, both Ma
    'Bhatiyar':                         'Major',   # Komal Re, Shuddha Ga, both Ma
    'Chakravakam / Ahir Bhairav':       'Major',   # Komal Re, Shuddha Ga, Komal Ni
    'Charukeshi':                       'Major',   # 26th mela — Shuddha Ga, Komal Dha/Ni
    'Dharmavati':                       'Minor',   # 59th mela — Komal Ga, Tivra Ma
    'Dwijavanti / Jaijaivanti':         'Mixed',   # Both Ga and Komal Ga, both Ni types
    'Gambhira Nattai':                  'Major',   # Shuddha Ga (the E♭ in its scale is R3, not a komal Ga)
    'Hemavati':                         'Minor',   # 58th mela — Komal Ga, Tivra Ma, Komal Ni
    'Hamsanandi / Marwa':               'Major',   # Komal Re, Shuddha Ga, Tivra Ma
    'Hamsanandi / Sohini':              'Major',   # Komal Re, Shuddha Ga, Tivra Ma
    'Jog':                              'Mixed',   # Both Ga and Komal Ga
    'Kapi':                             'Minor',   # Komal Ga, both Ni
    'Lalit':                            'Major',   # Komal Re, Shuddha Ga, both Ma
    'Madhuvanti':                       'Minor',   # Komal Ga, Tivra Ma
    'Mayamalavagowla / Bhairav':        'Major',   # 15th mela — Komal Re/Dha, Shuddha Ga
    'Pantuvarali / Puriya Dhanashri':   'Major',   # 51st mela — Komal Re, Shuddha Ga, Tivra Ma
    'Pilu':                             'Mixed',   # Multiple Ga variants
    'Purvikalyani / Puriya Kalyan':     'Major',   # Komal Re, Shuddha Ga, Tivra Ma
    'Raga Mishran':                     'Mixed',   # Mixed by name and nature
    'Ragavardhini':                     'Major',   # 32nd mela — Shuddha Ga
    'Sarasangi / Nat Bhairav':          'Major',   # 27th mela — Shuddha Ga, Komal Dha
    'Shree - Carnatic':                 'Minor',   # 22nd mela janya — Komal Ga
    'Vachaspati':                       'Major',   # 64th mela — Shuddha Ga, Tivra Ma, Komal Ni
    'Vibhas':                           'Major',   # Komal Re/Dha, Shuddha Ga

    # Mishra mixed
    'Mishra Jog':                       'Mixed',
    'Mishra Kapi':                      'Minor',
    'Mishra Pilu':                      'Mixed',
    'Mishra Sarasangi / Nat Bhairav':   'Major',
    'Mishra Srothaswini':               'Minor',

    # Ragas added with the Sai Rhythms import
    'Ananda Bhairavi':                  'Minor',   # 20th mela janya, Komal Ga
    'Asavari Todi':                     'Minor',
    'Bahudari':                         'Major',
    'Bhairavi - Carnatic':              'Minor',
    'Bilaskhani Todi':                  'Minor',
    'Gaud Sarang':                      'Major',
    'Karna Ranjani':                    'Minor',
    'Megh':                             'Minor',   # No Ga; Kafi thaat
    'Nand':                             'Major',
    'Ranjani':                          'Minor',
    'Shuddh Kalyani':                   'Major',
    'Shuddha Hindolam':                 'Minor',
    'Srothaswini':                      'Minor',
    'Vasantha':                         'Major',
    'Vijaya Saraswathi':                'Minor',
}

LABEL_RE = re.compile(r'^(Major and Minor|Major|Minor)\s*\((.*)\)$')

def get_scale(raga):
    """Scale for a raga name as written on Sai Rhythms. Handles the site's
    decorations: "~ X" (approximately X), "Major (X)" / "Minor (X)" /
    "Major and Minor (X)" (the explicit label wins), and "Mishra X"."""
    if not raga:
        return ''
    raga = raga.strip()
    if raga in SCALE_MAP:
        return SCALE_MAP[raga]
    m = LABEL_RE.match(raga)
    if m:
        return 'Mixed' if m.group(1) == 'Major and Minor' else m.group(1)
    if raga.startswith('~'):
        return get_scale(raga[1:])
    if raga.startswith('Mishra '):
        return get_scale(raga[len('Mishra '):])
    return ''

# ── Main transform ────────────────────────────────────────────────────────────

def transform(src, dst):
    data = json.loads(Path(src).read_text(encoding='utf-8'))

    missing_ragas = set()
    for b in data:
        # Split pitches (and rewrite the combined string to match)
        for g in ('gents', 'ladies'):
            ind, west = split_pitch(b.get(f'{g}_pitch') or '')
            b[f'{g}_pitch_indian'] = ind
            b[f'{g}_pitch_western'] = west
            if west:
                b[f'{g}_pitch'] = f'{ind} / {west}'

        # Scale — entries with no raga keep any hand-set value
        raga = b.get('raga') or ''
        if raga:
            scale = get_scale(raga)
            b['scale'] = scale
            if not scale:
                missing_ragas.add(raga)
        elif not b.get('scale'):
            b['scale'] = ''

    if missing_ragas:
        print(f'WARNING — {len(missing_ragas)} ragas not in SCALE_MAP:')
        for r in sorted(missing_ragas):
            print(f'  {r!r}')

    Path(dst).write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding='utf-8'
    )
    print(f'Written {len(data)} entries to {dst}')

if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'data/bhajans.json'
    dst = sys.argv[2] if len(sys.argv) > 2 else src
    transform(src, dst)
