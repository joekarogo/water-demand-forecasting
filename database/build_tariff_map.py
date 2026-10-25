"""
Builds database/tariff_type_map.csv from a hand-reviewed mapping of each
consumption_type (from database/tariff_type_map_proposal.csv) to a tariff
subscriber_type valid on 2024-07-01, or to nothing ("unpriced") when no
tariff applies.

NOTE: the `tariffs` table is not populated yet (load_tariffs.py has not
been run), so the exact stored subscriber_type strings this script matches
against are read directly from the source tariff CSV instead —
load_tariffs.py stores exactly row['ABONE_TIPI'].strip(), so this is
identical to what the table would contain.
"""

import re
import sys
import pandas as pd
from datetime import datetime
import os
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

PROPOSAL_PATH = os.path.join(os.path.dirname(__file__), 'tariff_type_map_proposal.csv')
TARIFF_PATH = os.getenv("IZSU_TARIFF_PATH", r"C:\Users\HomePC\Documents\su-atiksu-tarifeleri.csv")
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), 'tariff_type_map.csv')
AS_OF_DATE = datetime(2024, 7, 1).date()
UNPRICED_NOTE = "no matching tariff in the 2024-07-01 price list"


def normalize(s):
    return re.sub(r'\s+', ' ', s.strip()).upper()


def parse_valid_from(text):
    try:
        return datetime.strptime(text.split(' ')[0], '%m/%d/%Y').date()
    except (ValueError, IndexError):
        return None


# ---------------------------------------------------------------------------
# Tariff subscriber_types valid on 2024-07-01 (see note above re: the
# tariffs table).
# ---------------------------------------------------------------------------
tariff_raw = pd.read_csv(TARIFF_PATH, sep=';', encoding='utf-8-sig')
tariff_su = tariff_raw[tariff_raw['TUR'] == 'SU'].copy()
tariff_su['valid_from'] = tariff_su['GECERLILIK_TARIHI'].apply(parse_valid_from)
current_tariff_types = sorted(
    tariff_su.loc[tariff_su['valid_from'] == AS_OF_DATE, 'ABONE_TIPI'].str.strip().unique()
)
normalized_tariff_map = {normalize(t): t for t in current_tariff_types}


def resolve_tariff_type(name):
    """Normalise-match `name` against the current tariff subscriber types,
    returning the EXACT stored string — never guesses."""
    norm = normalize(name)
    if norm not in normalized_tariff_map:
        sys.exit(
            f"ERROR: tariff_type {name!r} does not normalise-match any "
            f"subscriber_type valid on {AS_OF_DATE}."
        )
    return normalized_tariff_map[norm]


# ---------------------------------------------------------------------------
# Hand-reviewed mapping.
# ---------------------------------------------------------------------------
EXACT = {
    'KONUT': 'KONUT ABONELERİ',
    'İŞYERİ': 'İŞYERİ ABONELERİ',
    'RESMİ DAİRE': 'RESMİ DAİRE ABONELERİ',
    'BELDE KONUT ABONELERİ': 'BELDE KONUT ABONELERİ',
    'İBADETHANELER': 'İBADETHANELER',
}

ASSUMPTION_GROUPS = [
    ('KÖY KONUT ABONELERİ',
     ['ORMAN KÖYÜ VE ESKİ KÖYLER KONUT', '5216 ESKİ KÖY KONUT', 'KIRSAL KONUT ( KÖY)'],
     'village/old-village homes -> village home tariff'),
    ('KONUT ABONELERİ',
     ['KONUT (S)', 'KONUT (AFET)', 'İLK KADEME BEL.KONUT', 'KIRSAL KONUT (MERKEZ)', 'KIRSAL KONUT (MAHALLE)'],
     'residential subtypes -> standard residential tariff'),
    ('BELDE KONUT ABONELERİ',
     ['KIRSAL KONUT (BELDE)'],
     'belde (town) rural home -> belde home tariff'),
    ('KONUT ABONELERİ (ATIKSU BEDELSİZ)',
     ['ATIKSU BEDELSİZ KONUT'],
     'wastewater-exempt home -> residential tariff (wastewater-exempt)'),
    ('PARK VE MEZARLIK ABONELERİ',
     ['PARKLAR VE MEZARLIKLAR', 'PARKLAR VE MEZARLIKLAR (TÜK. BİLD. İNECEK)'],
     'parks/cemeteries -> parks & cemeteries tariff'),
    ('RESMİ DAİRE ABONELERİ',
     ['RESMİ OKUL HASTANELER', 'RESMİ DAİRE İÇME SUYU', 'RESMİ DAİRE (TÜK.BİLD.İNECEK)', 'R. OKUL HAS. (TÜK. BİLD. İNE.)'],
     'official schools/hospitals/offices -> official office tariff'),
    ('RESMİ DAİRE ABONELERİ (ATIKSU BEDELSIZ)',
     ['ATIKSU BEDELSİZ RESMİ OKUL HASTANE'],
     'wastewater-exempt official office -> official office tariff (wastewater-exempt)'),
    ('SERBEST BÖLGE VE ORGANİZE SANAYİ ABONELERİ (ATIKSU BEDELSIZ)',
     ['ORGANİZE SANAYİ ABONELERİ(ATIKSU BEDELSİZ'],
     'wastewater-exempt organized industry -> free zone/industry tariff (wastewater-exempt)'),
    ('SERBEST BÖLGE VE ORGANİZE SANAYİ ABONELERİ',
     ['ORGANİZE SANAYİ VE SERBEST BÖLGE ABONELERİ(S)', 'ORGANİZE SANAYİ VE SERBEST BÖLGE ABONELERİ(O)'],
     'organized industry/free zone -> free zone & industry tariff'),
    ('TARIMSAL SULAMA VE HAYVANCILIK ABONELERİ',
     ['ORMAN KÖYÜ VE ESKİ KÖYLER TARIM/ HAYVAN', 'İLÇE BELEDİYE TARIM / HAYVAN', 'BELDE TARIM HAYVAN',
      '5216 ESKİ KÖY TARIM HAYVAN', 'İLK KADEME BEL.TARIM / HAYVAN', 'GERİ KAZANIM TARIMSAL'],
     'farm/livestock subtypes -> agricultural irrigation & livestock tariff'),
    ('İŞYERİ ABONELERİ',
     ['ORMAN KÖYÜ VE ESKİ KÖYLER İŞYERİ', 'BELDE İŞYERİ ABONELERİ', '5216 ESKİ KÖY İŞYERİ', 'PANDEMİ İŞYERİ',
      'PANDEMİ BELDE İŞYERİ', 'İŞYERİ TÜRGEV', 'KIRSAL İŞYERİ ( KÖY)', 'KIRSAL İŞYERİ (MERKEZ)',
      'KIRSAL İŞYERİ ( MAHALLE)', 'KIRSAL İŞYERİI (BELDE)'],
     'business subtypes -> standard business tariff'),
    ('İŞYERİ ABONELERİ (ATIKSU BEDELSİZ)',
     ['ATIKSU BEDELSİZ İŞYERİ'],
     'wastewater-exempt business -> business tariff (wastewater-exempt)'),
    ('ŞEHİT YAKINI/GAZİ ABONELERİ',
     ['ŞEHİT GAZİ', 'KÖY ŞEHİT GAZİ', 'BELDE ŞEHİT- GAZİ ABONELERİ', '5216 ESKİ KÖY ŞEHİT GAZİ',
      'KIRSAL ŞEHİT GAZİ (MERKEZ)', 'KIRSAL ŞEHİT GAZİ ( KÖY)', 'KIRSAL ŞEHİT GAZİ (MAHALLE)', 'KIRSAL ŞEHİT GAZİ (BELDE)'],
     'martyr family/veteran subtypes -> martyr & veteran tariff'),
    ('ŞEHİT YAKINI/GAZİ ABONELERİ (ATIKSU BEDELSIZ)',
     ['ATIKSU BEDELSİZ ŞEHİT GAZİ'],
     'wastewater-exempt martyr/veteran -> martyr & veteran tariff (wastewater-exempt)'),
    ('ENGELLİ ABONELERİ',
     ['BELDE ENGELLİ ABONELERİ', 'KÖY ENGELLİ', '5216 ESKİ KÖY ENGELLİ'],
     'disabled-subscriber subtypes -> disabled-subscriber tariff'),
    ('ENGELLİ ABONELERİ (ATIKSU BEDELSIZ)',
     ['ATIKSU BEDELSİZ ENGELLİ'],
     'wastewater-exempt disabled subscriber -> disabled tariff (wastewater-exempt)'),
    ('ÖZEL HASTANE ABONELERİ',
     ['ÖZEL HASTANELER'],
     'private hospitals -> private hospital tariff'),
    ('ÖZEL YURT ABONELERİ',
     ['ÖZEL YURTLAR'],
     'private dormitories -> private dormitory tariff'),
    ('NATO VE ELÇİLİK ABONELERİ',
     ['NATO ( KDV SİZ) ABONELER', 'ELÇİLİK ABONELERİ'],
     'NATO/embassy subtypes -> NATO & embassy tariff'),
]

UNPRICED = [
    'E.A.', 'BELEDİYE', 'BELEDİYE (TÜK BİLD. İNECEK)', 'İNŞAAT (ŞANTİYE)', 'BELDE ŞANTİYE ABONELERİ',
    'ATIKSU BEDELSİZ İNŞAAT', 'TURİSTİK TESİS', 'FIRIN HAMAM ABONELERİ', 'FIRIN HAMAM ŞİRKET', 'ÖZEL OKULLAR',
    'KYK YURTLAR', 'İLÇE BELEDİYESİ BAHÇE SUYU', 'ORMAN KÖYÜ VE ESKİ KÖYLER BAHÇE SUYU', 'BELDE BAHÇE ABONELERİ',
    '5216 ESKİ KÖY BAHÇE SUYU', 'KIRSAL BAHÇE SUYU (MERKEZ)', 'KIRSAL BAHÇE SUYU ( KÖY)',
    'ATIKSU BEDELSİZ BAHÇE SULAMA', 'KIRSAL E.A.(MERKEZ)', 'KIRSAL E.A. (MAHALLE)', 'KIRSAL E.A.( KÖY)',
    'KIRSAL E.A (BELDE)', 'BAKIMEVLERİ', 'AİLEHEKİM.RES.HAS.', 'SPOR KLUPLERİ', 'RESMİ KIZILAY KAN',
    'HAMSU KONUTDIŞI', 'MUHTARLIKLAR', 'LİMAN ABONELERİ', 'KÜLTÜR BELGELİ', 'SANAYİ',
]

# Per-item overrides of UNPRICED_NOTE, for entries that need a more specific
# reason than the generic one.
UNPRICED_CUSTOM_NOTES = {
    'SANAYİ': ('no general industry tariff in the 2024-07-01 price list; '
               'zone tariff applies only to organised industrial zones'),
}

# Build a normalized lookup: normalize(hand-written source name) -> row data.
# A collision here (the same normalized name given twice) is our own
# transcription error, not a proposal-data problem — fail loudly.
normalized_rule_map = {}


def add_rule(name, tariff_type, is_assumption, note):
    norm = normalize(name)
    if norm in normalized_rule_map:
        sys.exit(f"ERROR: {name!r} is listed more than once in the hand-reviewed mapping.")
    resolved_tariff_type = resolve_tariff_type(tariff_type) if tariff_type else None
    normalized_rule_map[norm] = {
        'tariff_type': resolved_tariff_type,
        'is_assumption': is_assumption,
        'note': note,
    }


for consumption_type, tariff_type in EXACT.items():
    add_rule(consumption_type, tariff_type, False, '')

for target_tariff_type, sources, note in ASSUMPTION_GROUPS:
    for source in sources:
        add_rule(source, target_tariff_type, True, note)

for consumption_type in UNPRICED:
    note = UNPRICED_CUSTOM_NOTES.get(consumption_type, UNPRICED_NOTE)
    add_rule(consumption_type, None, False, note)

# ---------------------------------------------------------------------------
# Walk the actual proposal — always write back ITS exact strings, never our
# hand-transcribed ones (which could differ in whitespace).
# ---------------------------------------------------------------------------
proposal = pd.read_csv(PROPOSAL_PATH)

missing_from_rules = []
rows = []
used_norms = set()
for _, row in proposal.iterrows():
    consumption_type = row['consumption_type']
    norm = normalize(consumption_type)
    if norm not in normalized_rule_map:
        missing_from_rules.append(consumption_type)
        continue
    used_norms.add(norm)
    rule = normalized_rule_map[norm]
    rows.append({
        'consumption_type': consumption_type,  # proposal's own exact string
        'tariff_type': rule['tariff_type'] or '',
        'is_assumption': rule['is_assumption'],
        'note': rule['note'],
        '_share_pct': row['share_pct'],  # kept for the summary below, dropped before writing
    })

if missing_from_rules:
    sys.exit(
        "ERROR: these proposal consumption types have no entry in the hand-reviewed "
        f"mapping ({len(missing_from_rules)}): {missing_from_rules}"
    )

extra_in_rules = set(normalized_rule_map) - used_norms
if extra_in_rules:
    originals = [normalized_tariff_map.get(n, n) for n in extra_in_rules]
    sys.exit(
        "ERROR: these entries in the hand-reviewed mapping don't match any consumption "
        f"type in the proposal ({len(extra_in_rules)}): {sorted(extra_in_rules)}"
    )

if len(rows) != len(proposal):
    sys.exit(f"ERROR: built {len(rows)} rows but the proposal has {len(proposal)} rows.")

seen_types = set()
for row in rows:
    if row['consumption_type'] in seen_types:
        sys.exit(f"ERROR: {row['consumption_type']!r} appears more than once.")
    seen_types.add(row['consumption_type'])

output = pd.DataFrame(rows)
output[['consumption_type', 'tariff_type', 'is_assumption', 'note']].to_csv(OUTPUT_PATH, index=False)

print(f"VALIDATED: all {len(rows)} proposal consumption types mapped exactly once.")
print(f"Every non-empty tariff_type resolved against a real subscriber_type valid on {AS_OF_DATE}.")
print(f"\ntariff_type_map.csv written to {OUTPUT_PATH}")

print("\nCounts and consumption share per category:")
exact_rows = [r for r in rows if r['tariff_type'] and not r['is_assumption']]
assumption_rows = [r for r in rows if r['tariff_type'] and r['is_assumption']]
unpriced_rows = [r for r in rows if not r['tariff_type']]

for label, group in [('exact', exact_rows), ('assumption', assumption_rows), ('unpriced', unpriced_rows)]:
    share = sum(r['_share_pct'] for r in group)
    print(f"  {label}: {len(group)} rows, {share:.2f}% of consumption")

priced_share = sum(r['_share_pct'] for r in exact_rows + assumption_rows)
print(f"\nTotal priced share (exact + assumption): {priced_share:.2f}%")
