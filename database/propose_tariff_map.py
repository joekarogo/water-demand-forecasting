"""
Proposes a subscriber_type -> tariff_type mapping (tariff_type_map), by
exact-matching each detail-file subscriber_type against the tariff
subscriber_types valid on 2024-07-01 (the latest tariff date). Writes a CSV
proposal only — never loads it into the database. Read-only on the database
(it doesn't even need to connect, since both its inputs are CSV files).
"""

import re
import pandas as pd
from datetime import datetime
import os
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

DETAIL_PATH = os.getenv("IZSU_DETAIL_PATH", r"C:\Users\HomePC\Documents\izsu_detail_monthly.csv")
TARIFF_PATH = os.getenv("IZSU_TARIFF_PATH", r"C:\Users\HomePC\Documents\su-atiksu-tarifeleri.csv")
PROPOSAL_PATH = os.path.join(os.path.dirname(__file__), 'tariff_type_map_proposal.csv')

AS_OF_DATE = datetime(2024, 7, 1).date()


def normalize(s):
    return re.sub(r'\s+', ' ', s.strip()).upper()


def parse_valid_from(text):
    try:
        return datetime.strptime(text.split(' ')[0], '%m/%d/%Y').date()
    except (ValueError, IndexError):
        return None


# ---------------------------------------------------------------------------
# Every distinct (subscriber_type, customer_group) in the detail file, with
# its share of total consumption.
# ---------------------------------------------------------------------------
detail = pd.read_csv(DETAIL_PATH)

totals = (
    detail.groupby(['subscriber_type', 'customer_group'])['consumption_m3']
    .sum()
    .reset_index()
)
grand_total = detail['consumption_m3'].sum()
totals['share_pct'] = totals['consumption_m3'] / grand_total * 100
totals = totals.sort_values('share_pct', ascending=False).reset_index(drop=True)

# ---------------------------------------------------------------------------
# Tariff subscriber_types valid on 2024-07-01 (water tariffs only).
# ---------------------------------------------------------------------------
tariff_raw = pd.read_csv(TARIFF_PATH, sep=';', encoding='utf-8-sig')
tariff_su = tariff_raw[tariff_raw['TUR'] == 'SU'].copy()
tariff_su['valid_from'] = tariff_su['GECERLILIK_TARIHI'].apply(parse_valid_from)
current_tariff_types = sorted(
    tariff_su.loc[tariff_su['valid_from'] == AS_OF_DATE, 'ABONE_TIPI'].str.strip().unique()
)

print(f"Tariff subscriber_types valid on {AS_OF_DATE}:")
for t in current_tariff_types:
    print(f"  {t}")

normalized_map = {normalize(t): t for t in current_tariff_types}

# ---------------------------------------------------------------------------
# Match: exact (after normalising), or consumption_type + " ABONELERİ".
# Leave blank otherwise — no fuzzy/partial matching.
# ---------------------------------------------------------------------------
rows = []
for _, row in totals.iterrows():
    consumption_type = row['subscriber_type']
    norm = normalize(consumption_type)

    if norm in normalized_map:
        tariff_type = normalized_map[norm]
        match_method = 'exact'
    elif normalize(consumption_type + ' ABONELERİ') in normalized_map:
        tariff_type = normalized_map[normalize(consumption_type + ' ABONELERİ')]
        match_method = 'suffix_abonelik'
    else:
        tariff_type = ''
        match_method = ''

    rows.append({
        'consumption_type': consumption_type,
        'customer_group': row['customer_group'],
        'share_pct': round(row['share_pct'], 4),
        'tariff_type': tariff_type,
        'match_method': match_method,
    })

proposal = pd.DataFrame(rows)
proposal.to_csv(PROPOSAL_PATH, index=False)

matched_share = proposal.loc[proposal['match_method'] != '', 'share_pct'].sum()
print(f"\nProposal written to {PROPOSAL_PATH}")
print(f"Rows: {len(proposal)}, matched: {(proposal['match_method'] != '').sum()}")
print(f"Total share (%) of rows with a match: {matched_share:.2f}%")
