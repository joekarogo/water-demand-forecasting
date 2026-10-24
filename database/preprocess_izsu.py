"""
Builds the monthly İZSU consumption file (izsu_monthly_consumption.csv) from
the raw İZSU billed-records download, so that preprocessing step is part of
the repo and reproducible — rather than a one-off transformation someone did
outside it.

Source: İzmir Metropolitan Municipality Open Data Portal,
https://acikveri.bizizmir.com/en/dataset/yillik-ilce-ve-mahalle-bazli-su-tuketim-miktarlari
"""

import csv
import os
import shutil
import sys
import tempfile
import pandas as pd
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

DEFAULT_RAW_PATH = r"C:\Users\HomePC\Documents\izsu-yillik-ilce-mahalle-su-tuketimi.csv"
DEFAULT_MONTHLY_PATH = r"C:\Users\HomePC\Documents\izsu_monthly_consumption.csv"

RAW_PATH = os.getenv("IZSU_RAW_PATH", DEFAULT_RAW_PATH)
MONTHLY_PATH = os.getenv("IZSU_MONTHLY_PATH", DEFAULT_MONTHLY_PATH)

OUTPUT_COLUMNS = ['date', 'consumption_m3', 'consumption_cleaned_m3', 'is_outlier', 'subscribers']

# ---------------------------------------------------------------------------
# 1. Read the raw file
# ---------------------------------------------------------------------------
raw = pd.read_csv(RAW_PATH, sep=';', encoding='utf-8-sig')

# ---------------------------------------------------------------------------
# 2. Raw record count and date range
# ---------------------------------------------------------------------------
raw_min = (int(raw['YIL'].min()), int(raw.loc[raw['YIL'] == raw['YIL'].min(), 'AY'].min()))
raw_max = (int(raw['YIL'].max()), int(raw.loc[raw['YIL'] == raw['YIL'].max(), 'AY'].max()))
print(f"Raw records: {len(raw)}")
print(f"Raw date range: {raw_min[0]}-{raw_min[1]:02d} to {raw_max[0]}-{raw_max[1]:02d}")

# ---------------------------------------------------------------------------
# 3. Keep water-supply rows only (exclude wastewater, to avoid double counting)
# ---------------------------------------------------------------------------
is_water = raw['ABONELIK_TURU'] == 'Su'
kept = raw[is_water]
excluded = raw[~is_water]
print(f"Rows kept (ABONELIK_TURU == 'Su'): {len(kept)}")
print(f"Rows excluded (wastewater / other): {len(excluded)}")

# ---------------------------------------------------------------------------
# 4. Aggregate per year and month.
#    NOTE: despite its name ("average consumption"), ORTALAMA_TUKETIM holds
#    each row's TOTAL consumption for that subscriber group/month, not an
#    average — summing it per month gives the month's total consumption.
# ---------------------------------------------------------------------------
monthly = (
    kept.groupby(['YIL', 'AY'])
    .agg(consumption_m3=('ORTALAMA_TUKETIM', 'sum'), subscribers=('ABONE_ADEDI', 'sum'))
    .reset_index()
)
monthly['date'] = pd.to_datetime(
    monthly['YIL'].astype(str) + '-' + monthly['AY'].astype(str) + '-01'
)
monthly = monthly.sort_values('date').reset_index(drop=True)

# ---------------------------------------------------------------------------
# 5. Drop the last, incomplete month(s)
# ---------------------------------------------------------------------------
cutoff = monthly['date'].max()
row_counts_by_month = kept.groupby(['YIL', 'AY']).size()
last_month_rows = row_counts_by_month.get((cutoff.year, cutoff.month))
typical_rows = row_counts_by_month.drop(index=(cutoff.year, cutoff.month)).tail(3).mean()
print(
    f"Dropping {cutoff.strftime('%Y-%m')} and any later month as incomplete: "
    f"it has only {last_month_rows} water-supply records vs. an average of "
    f"{typical_rows:.0f} for the preceding 3 months - the raw extract clearly "
    f"only captured a partial billing cycle for it."
)
monthly = monthly[monthly['date'] < cutoff].reset_index(drop=True)

# ---------------------------------------------------------------------------
# 6. Flag and interpolate outliers
# ---------------------------------------------------------------------------
rolling_median = monthly['consumption_m3'].rolling(window=13, center=True, min_periods=5).median()
is_outlier = (monthly['consumption_m3'] > 1.4 * rolling_median) | (monthly['consumption_m3'] < 0.6 * rolling_median)
monthly['is_outlier'] = is_outlier.map({True: 'yes', False: 'no'})

cleaned = monthly['consumption_m3'].astype(float).copy()
cleaned[is_outlier] = None
cleaned = cleaned.interpolate(method='linear')
monthly['consumption_cleaned_m3'] = cleaned.round().astype(int)

outlier_months = monthly.loc[is_outlier, 'date'].dt.strftime('%Y-%m').tolist()
print(f"Outlier months ({len(outlier_months)}): {', '.join(outlier_months)}")

# ---------------------------------------------------------------------------
# 7. Write the output
# ---------------------------------------------------------------------------
monthly['date'] = monthly['date'].dt.strftime('%Y-%m-%d')
monthly['consumption_m3'] = monthly['consumption_m3'].astype(int)
output = monthly[OUTPUT_COLUMNS]

tmp_fd, tmp_path = tempfile.mkstemp(suffix='.csv')
os.close(tmp_fd)
output.to_csv(tmp_path, index=False)
print(f"\nComputed output written to temporary file: {tmp_path}")

# ---------------------------------------------------------------------------
# VERIFY: never overwrite an existing monthly file without comparing first
# ---------------------------------------------------------------------------
if os.path.exists(MONTHLY_PATH):
    with open(tmp_path, newline='', encoding='utf-8') as f:
        new_rows = list(csv.reader(f))
    with open(MONTHLY_PATH, newline='', encoding='utf-8') as f:
        existing_rows = list(csv.reader(f))

    if new_rows == existing_rows:
        print(f"VERIFIED: all {len(new_rows) - 1} rows match the existing "
              f"{MONTHLY_PATH} exactly. File left untouched.")
        os.remove(tmp_path)
    else:
        print(f"MISMATCH between the computed output and {MONTHLY_PATH}. "
              f"Existing file left untouched. Differences:")
        max_len = max(len(new_rows), len(existing_rows))
        diff_count = 0
        for i in range(max_len):
            new_row = new_rows[i] if i < len(new_rows) else None
            existing_row = existing_rows[i] if i < len(existing_rows) else None
            if new_row != existing_row:
                diff_count += 1
                print(f"  Row {i}: computed={new_row!r} existing={existing_row!r}")
        print(f"\n{diff_count} differing row(s). Stopping without writing.")
        sys.exit(1)
else:
    shutil.move(tmp_path, MONTHLY_PATH)
    print(f"No existing file found at {MONTHLY_PATH} - wrote the new output there.")
