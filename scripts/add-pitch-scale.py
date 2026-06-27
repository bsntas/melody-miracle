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

PITCH_RE = re.compile(r'^([\d.]+\s+(?:Madhyam|Pancham))\s*/\s*(.+)$', re.IGNORECASE)

# Positions whose western label should be A# (not B)
A_SHARP_INDIAN = {'4 Madhyam', '6.5 Pancham'}

def split_pitch(raw):
    """Return (indian, western) from "X Pancham / Y" or similar."""
    if not raw:
        return '', ''
    m = PITCH_RE.match(raw.strip())
    if not m:
        return raw.strip(), ''
    indian = m.group(1).strip()
    western = m.group(2).strip()
    # Fix the two positions that should be A# (historically labelled B)
    if indian in A_SHARP_INDIAN and western == 'B':
        western = 'A#'
    return indian, western

# ── Raga → scale mapping ──────────────────────────────────────────────────────
# Classification: Major = bright (primarily shuddha / natural Ga)
#                 Minor = dark  (primarily komal Ga)
#                 Mixed = both Ga variants, or double madhyam, or complex chromatic

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
    'Gara':                              'Major',   # Khamaj thaat
    'Gavati':                            'Major',   # Shankarabharanam janya
    'Hamir Kalyani / Kedar':             'Major',   # Kalyani janya + Bilaval thaat
    'Hamsa Vahini':                      'Major',   # Shankarabharanam janya
    'Hamsadhwani':                       'Major',   # Sa Re Ga Pa Ni — major pentatonic
    'Hamsanadam':                        'Major',   # Major pentatonic variant
    'Hamsavinodini':                     'Major',   # Major feel
    'Harikamboji':                       'Major',   # 28th mela, shuddha Ga (Khamaj)
    'Kalyana Vasantham':                 'Major',   # Kalyani janya
    'Kalyani / Yaman':                   'Major',   # 65th mela, Lydian/Yaman — all major
    'Khamaj':                            'Major',   # Shuddha Ga, komal Ni (dominant)
    'Khamas':                            'Major',   # Harikamboji janya
    'Maand':                             'Major',   # Khamaj/Bilaval based
    'Mohana Kalyani / Shuddha Kalyan':   'Major',   # Mohanam + Kalyani blend
    'Mohanam / Bhoop':                   'Major',   # Sa Re Ga Pa Dha — major pentatonic
    'Maru Bihag':                        'Major',   # Primarily Bilaval with shuddha Ga
    'Natakurinji':                       'Major',   # Harikamboji janya
    'Nattai':                            'Major',   # Shuddha Ga, vigorous character
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
    'Mishra Gara':                       'Major',
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
    'Malayamarutham':                   'Minor',   # Komal Ga
    'Miyan ki Malhar':                  'Minor',   # Komal Ga, Komal Ni
    'Nadanamakriya':                    'Minor',   # Natabhairavi janya, Komal Ga
    'Naga Gandhari':                    'Minor',   # Minor character
    'Natabhairavi':                     'Minor',   # 20th mela — natural minor
    'Panchamkauns / Jayanthashri':      'Minor',   # Komal Ga
    'Parameshwari':                     'Minor',   # 68th mela, Komal Ga
    'Punnagavarali':                    'Minor',   # 8th mela janya, Komal Ga
    'Rageshri':                         'Minor',   # Komal Ga, no Pa
    'Revagupti':                        'Minor',   # Komal Ga
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
    'Suryakantham':                     'Minor',   # Natabhairavi janya, Komal Ga
    'Todi - Carnatic':                  'Minor',   # 8th mela — Komal Ga, Komal Re
    'Vakulabharanam / Basant Mukhari':  'Minor',   # Komal Ga
    'Varali':                           'Minor',   # Komal Ga, Komal Re, Tivra Ma
    'Janasammohini':                    'Minor',   # Minor feel

    # Mishra minor
    'Mishra Abheri / Bhimpalas':        'Minor',
    'Mishra Bageshri':                  'Minor',
    'Mishra Chandrakauns':              'Minor',
    'Mishra Darbari':                   'Minor',
    'Mishra Gowri Manohari / Patdeep':  'Minor',
    'Mishra Hindolam / Malkauns':       'Minor',
    'Mishra Keeravani':                 'Minor',
    'Mishra Rageshri':                  'Minor',
    'Mishra Shanmukhapriya':            'Minor',
    'Mishra Shekara Chandrika / Gujari Todi': 'Minor',
    'Mishra Shivaranjani':              'Minor',
    'Mishra Sindhu Bhairavi / Bhairavi': 'Minor',
    'Mishra Vakulabharanam / Basant Mukhari': 'Minor',

    # ── Mixed ragas ──
    'Amruthavarshini':                  'Mixed',   # Tivra Ma + Shuddha Ga, Komal Dha
    'Basanth':                          'Mixed',   # Double madhyam, Komal Ga
    'Bhatiyar':                         'Mixed',   # Complex — both Ga types
    'Chakravakam / Ahir Bhairav':       'Mixed',   # Komal Re + Shuddha Ga + Komal Dha
    'Charukeshi':                       'Mixed',   # 26th mela — Shuddha Ga + Komal Dha/Ni
    'Dharmavati':                       'Mixed',   # 59th mela — Shuddha Ga + Tivra Ma + Komal Ni
    'Dwijavanti / Jaijaivanti':         'Mixed',   # Both Ga and Komal Ga, both Ni types
    'Gambhira Nattai':                  'Mixed',   # Complex character
    'Hemavati':                         'Mixed',   # 58th mela — Shuddha Ga + Komal Dha/Ni
    'Hamsanandi / Marwa':               'Mixed',   # Komal Re + Tivra Ma, complex
    'Hamsanandi / Sohini':              'Mixed',   # Similar complexity to Marwa
    'Jog':                              'Mixed',   # Both Ga and Komal Ga
    'Kapi':                             'Mixed',   # Both Ga variants used
    'Lalit':                            'Mixed',   # Double madhyam + Komal Re
    'Madhuvanti':                       'Mixed',   # Komal Ga + Tivra Ma
    'Mayamalavagowla / Bhairav':        'Mixed',   # 15th mela — Komal Re + Shuddha Ga + Komal Dha
    'Pantuvarali / Puriya Dhanashri':   'Mixed',   # 51st mela — Komal Re + Shuddha Ga + Tivra Ma
    'Pilu':                             'Mixed',   # Multiple Ga variants
    'Purvikalyani / Puriya Kalyan':     'Mixed',   # Komal Re + Shuddha Ga
    'Raga Mishran':                     'Mixed',   # Mixed by name and nature
    'Ragavardhini':                     'Mixed',   # 32nd mela — Komal Re + Shuddha Ga + Komal Dha/Ni
    'Sarasangi / Nat Bhairav':          'Mixed',   # 27th mela — Shuddha Ga + Komal Dha
    'Shree - Carnatic':                 'Mixed',   # Double madhyam + Komal Re
    'Shuddha Sarang':                   'Mixed',   # Wait, keeping Major above; correcting: actually Major
    'Vachaspati':                       'Mixed',   # 64th mela — Shuddha Ga + Tivra Ma + Komal Ni
    'Vibhas':                           'Mixed',   # Komal Re + Komal Dha + Shuddha Ga

    # Mishra mixed
    'Mishra Jog':                       'Mixed',
    'Mishra Kapi':                      'Mixed',
    'Mishra Pilu':                      'Mixed',
    'Mishra Sarasangi / Nat Bhairav':   'Mixed',
    'Mishra Srothaswini':               'Mixed',
    'Mishra Gara':                      'Major',   # Gara is major-based
}

def get_scale(raga):
    if not raga:
        return ''
    return SCALE_MAP.get(raga, '')

# ── Main transform ────────────────────────────────────────────────────────────

def transform(src, dst):
    data = json.loads(Path(src).read_text(encoding='utf-8'))

    missing_ragas = set()
    for b in data:
        # Split pitches
        gi, gw = split_pitch(b.get('gents_pitch', ''))
        li, lw = split_pitch(b.get('ladies_pitch', ''))
        b['gents_pitch_indian']  = gi
        b['gents_pitch_western'] = gw
        b['ladies_pitch_indian'] = li
        b['ladies_pitch_western'] = lw

        # Scale
        raga = b.get('raga', '')
        scale = get_scale(raga)
        b['scale'] = scale
        if raga and not scale:
            missing_ragas.add(raga)

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
