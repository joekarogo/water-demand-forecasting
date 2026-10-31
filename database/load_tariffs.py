"""
Loads İZSU water tariffs (TUR == 'SU' only; TUR == 'ATIK SU' / 'KÖP' rows are
wastewater / other and excluded) into the tariffs table.
"""

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime
import os
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

TARIFF_PATH = os.getenv("IZSU_TARIFF_PATH", r"C:\Users\HomePC\Documents\su-atiksu-tarifeleri.csv")


def parse_band(text):
    """'   0-   4 m3' -> (0, 4). '  20-üstü m3' -> (20, None) ('üstü' = 'and
    above', i.e. no upper limit). Returns None if the text doesn't match
    this shape at all, rather than guessing."""
    text = text.strip()
    if not text.endswith('m3'):
        return None
    body = text[:-2].strip()
    parts = body.split('-', 1)
    if len(parts) != 2:
        return None
    min_part, max_part = parts[0].strip(), parts[1].strip()
    try:
        band_min = float(min_part)
    except ValueError:
        return None
    if max_part == 'üstü':
        band_max = None
    else:
        try:
            band_max = float(max_part)
        except ValueError:
            return None
    return band_min, band_max


def parse_valid_from(text):
    """'7/1/2024 12:00:00 AM' (month/day/year) -> date. Returns None, rather
    than guessing, if it doesn't parse."""
    try:
        return datetime.strptime(text.split(' ')[0], '%m/%d/%Y').date()
    except (ValueError, IndexError):
        return None


raw = pd.read_csv(TARIFF_PATH, sep=';', encoding='utf-8-sig')
su = raw[raw['TUR'] == 'SU'].copy()

parsed_rows = []
failed_rows = []

for _, row in su.iterrows():
    band = parse_band(row['BARAJ_METRE_KUP'])
    valid_from = parse_valid_from(row['GECERLILIK_TARIHI'])
    if band is None or valid_from is None:
        failed_rows.append(row)
        continue
    band_min, band_max = band
    parsed_rows.append({
        'subscriber_type': row['ABONE_TIPI'].strip(),
        'band_min_m3': band_min,
        'band_max_m3': band_max,
        'price_per_m3': float(row['SU_FIYATI']),
        # The same SU (water) rows carry the matching wastewater price for
        # this subscriber_type/band/date in ATIKSU_FIYATI — no separate
        # ATIK SU rows need loading. 0 stays 0 (e.g. "ATIKSU BEDELSİZ"
        # subscriber types, which are wastewater-exempt).
        'wastewater_price_per_m3': float(row['ATIKSU_FIYATI']),
        'currency': 'TRY',
        'valid_from': valid_from,
        'source': 'IZSU su-atiksu-tarifeleri.csv',
    })

parsed = pd.DataFrame(parsed_rows)

print(f"Rows loaded: {len(parsed)} (expected 1,582)")

if failed_rows:
    print(f"\nRows that failed to parse ({len(failed_rows)}):")
    for row in failed_rows:
        print(f"  {row.to_dict()}")

valid_from_dates = sorted(parsed['valid_from'].unique())
print(f"\nDistinct valid_from dates: {len(valid_from_dates)} (expected 39)")
print(f"First: {valid_from_dates[0]}, Last: {valid_from_dates[-1]}")

# Duplicates: same subscriber_type + band + valid_from. All water rows are
# loaded exactly as published — ambiguous groups (same key, different
# water OR wastewater prices) are NOT resolved here. Instead, the
# revenue-calculation logic (backend/revenue.js) detects them at query
# time and reports "unavailable: ambiguous tariff in source data" for the
# affected subscriber_type/band/date rather than guessing which price
# applies.
dup_key = ['subscriber_type', 'band_min_m3', 'band_max_m3', 'valid_from']
ambiguous_groups = []
# dropna=False: band_max_m3 is NaN for every "üstü" (no-upper-limit) band —
# pandas groupby() silently drops NaN-keyed rows by default, which would
# silently exclude most of these groups from ambiguity detection.
for key, group in parsed.groupby(dup_key, dropna=False):
    if len(group) <= 1:
        continue
    water_prices = sorted(group['price_per_m3'].unique())
    wastewater_prices = sorted(group['wastewater_price_per_m3'].unique())
    if len(water_prices) > 1 or len(wastewater_prices) > 1:
        ambiguous_groups.append(
            (key, len(group), list(group['price_per_m3']), list(group['wastewater_price_per_m3']))
        )

print(f"\nAmbiguous groups (same type + band + valid_from, different water or wastewater prices): {len(ambiguous_groups)}")
ambiguous_dates = sorted({key[3] for key, _, _, _ in ambiguous_groups})
print(f"Dates these fall on ({len(ambiguous_dates)}): {', '.join(str(d) for d in ambiguous_dates)}")

latest_date = valid_from_dates[-1]
on_latest = [g for g in ambiguous_groups if g[0][3] == latest_date]
print(f"\nAmbiguous groups on the latest date ({latest_date}) — in full:")
if on_latest:
    for key, n, water_prices, wastewater_prices in on_latest:
        print(f"  {key}: {n} rows, water prices {water_prices}, wastewater prices {wastewater_prices}")
else:
    print("  None.")

# One transaction: clear existing rows, insert all, commit.
conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT")
)
ustu_row_count = int(parsed['band_max_m3'].isna().sum())

cursor = conn.cursor()
try:
    cursor.execute("DELETE FROM tariffs")
    insert_cols = [
        'subscriber_type', 'band_min_m3', 'band_max_m3', 'price_per_m3',
        'wastewater_price_per_m3', 'currency', 'valid_from', 'source',
    ]
    # Convert NaN -> None before inserting, so psycopg2 sends SQL NULL
    # rather than the numeric NaN value (which Postgres would otherwise
    # happily store in a NUMERIC column) — this matters especially for
    # band_max_m3, which is NaN for every "üstü" (no-upper-limit) band.
    records_df = parsed[insert_cols].astype(object).where(parsed[insert_cols].notna(), None)
    records = records_df.values.tolist()
    execute_values(cursor, """
        INSERT INTO tariffs
            (subscriber_type, band_min_m3, band_max_m3, price_per_m3,
             wastewater_price_per_m3, currency, valid_from, source)
        VALUES %s
    """, records)
    conn.commit()
except Exception:
    conn.rollback()
    cursor.close()
    conn.close()
    raise

print(f"\nLoaded {len(parsed)} rows into tariffs.")

# Verify the NaN -> None conversion actually landed as SQL NULL, not a
# stored numeric NaN.
cursor.execute("SELECT COUNT(*) FROM tariffs WHERE band_max_m3 IS NULL")
null_count = cursor.fetchone()[0]
print(f"\nRows with band_max_m3 IS NULL: {null_count} "
      f"(number of 'üstü' rows in the file: {ustu_row_count})")

cursor.execute("SELECT COUNT(*) FROM tariffs WHERE band_max_m3 = 'NaN'::numeric")
nan_count = cursor.fetchone()[0]
print(f"Rows where band_max_m3 = 'NaN'::numeric: {nan_count} (must be 0)")

cursor.execute("SELECT COUNT(*) FROM tariffs WHERE wastewater_price_per_m3 IS NOT NULL")
wastewater_count = cursor.fetchone()[0]

print("\n--- Summary ---")
print(f"Rows loaded: {len(parsed)}")
print(f"Distinct valid_from dates: {len(valid_from_dates)}")
print(f"Rows with a wastewater price loaded: {wastewater_count}")
print(f"Ambiguous groups (water or wastewater): {len(ambiguous_groups)} ({len(on_latest)} on the latest date)")

cursor.close()
conn.close()
