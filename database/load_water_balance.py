"""
Loads the 2019 İZSU water-loss (water balance) report into water_balance.
"""

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
import os
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

LOSS_PATH = os.getenv("IZSU_LOSS_PATH", r"C:\Users\HomePC\Documents\su-kayiplari-2019.csv")

COLUMN_MAP = {
    'YIL': 'year',
    'ILCE': 'district',
    'SISTEME_GIREN_SU_MIKTARI': 'system_input_m3',
    'GELIR_GETIREN_SU_MIKTARI': 'revenue_water_m3',
    'GELIR_GETIRMEYEN_SU_MIKTARI': 'non_revenue_water_m3',
    'SU_KAYIPLARI': 'water_losses_m3',
    'FIZIKI_KAYIPLAR': 'physical_losses_m3',
    'IDARI_KAYIPLAR': 'admin_losses_m3',
}
NUMERIC_SOURCE_COLS = [c for c in COLUMN_MAP if c not in ('ILCE',)]

raw = pd.read_csv(LOSS_PATH, sep=';', encoding='utf-8-sig', dtype=str)
df = raw[list(COLUMN_MAP.keys())].copy()
df['ILCE'] = df['ILCE'].str.strip()

# Some numbers in the source have a stray comma typed by mistake
# (e.g. "2924,372" means 2924372, not 2924.372) — strip commas before
# converting, and report every value this applied to.
for col in NUMERIC_SOURCE_COLS:
    for idx, val in df[col].items():
        if ',' in val:
            cleaned = val.replace(',', '')
            print(f"Cleaned stray comma: {col} for {df.at[idx, 'ILCE']}: {val!r} -> {cleaned}")
            df.at[idx, col] = cleaned
    df[col] = df[col].astype(int)

df = df.rename(columns=COLUMN_MAP)

print(f"\nDistricts: {len(df)} (expected 20)")

total_input = df['system_input_m3'].sum()
total_nrw = df['non_revenue_water_m3'].sum()
print(f"Total system_input_m3: {total_input:,} (expected 291,984,950)")
print(f"Total non_revenue_water_m3: {total_nrw:,} (expected 94,579,006)")
print(f"NRW share: {total_nrw / total_input * 100:.1f}% (expected 32.4%)")

print("\nPer-district balance check (system_input = revenue_water + non_revenue_water):")
# Data is loaded exactly as published regardless of this check — any
# mismatch found here is the source report's own arithmetic, not an error
# introduced by this script, so it's labeled as such rather than as an
# error that would block loading.
any_mismatch = False
for _, row in df.iterrows():
    expected = row['revenue_water_m3'] + row['non_revenue_water_m3']
    if expected != row['system_input_m3']:
        any_mismatch = True
        diff = row['system_input_m3'] - expected
        print(f"  source data inconsistency (loaded as published) {row['district']}: "
              f"system_input={row['system_input_m3']:,}, "
              f"revenue+non_revenue={expected:,} (diff={diff:,})")
if not any_mismatch:
    print("  All districts balance.")

# One transaction: clear existing 2019 rows, insert all, commit.
conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT")
)
cursor = conn.cursor()
try:
    cursor.execute("DELETE FROM water_balance WHERE year = 2019")
    insert_cols = ['year', 'district', 'system_input_m3', 'revenue_water_m3', 'non_revenue_water_m3',
                   'water_losses_m3', 'physical_losses_m3', 'admin_losses_m3']
    # Convert NaN -> None before inserting, so psycopg2 sends SQL NULL
    # rather than a numeric NaN, if any value is missing.
    records_df = df[insert_cols].astype(object).where(df[insert_cols].notna(), None)
    records = records_df.values.tolist()
    execute_values(cursor, """
        INSERT INTO water_balance
            (year, district, system_input_m3, revenue_water_m3, non_revenue_water_m3,
             water_losses_m3, physical_losses_m3, admin_losses_m3)
        VALUES %s
    """, records)
    conn.commit()
except Exception:
    conn.rollback()
    cursor.close()
    conn.close()
    raise

cursor.close()
conn.close()
print(f"\nLoaded {len(df)} rows into water_balance for year 2019.")
