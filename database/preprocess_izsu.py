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
DEFAULT_DETAIL_PATH = r"C:\Users\HomePC\Documents\izsu_detail_monthly.csv"

RAW_PATH = os.getenv("IZSU_RAW_PATH", DEFAULT_RAW_PATH)
MONTHLY_PATH = os.getenv("IZSU_MONTHLY_PATH", DEFAULT_MONTHLY_PATH)
DETAIL_PATH = os.getenv("IZSU_DETAIL_PATH", DEFAULT_DETAIL_PATH)

OUTPUT_COLUMNS = ['date', 'consumption_m3', 'consumption_cleaned_m3', 'is_outlier', 'subscribers']

# The first 102 months (Jan 2014 - Jun 2022), matching the model's
# chronological 80/20 train/test split. Outlier detection must be fitted on
# training data only, so it never uses test-period information.
TRAIN_MONTHS = 102

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
# 6. Flag and interpolate outliers — fitted on the TRAINING period only
#    (TRAIN_MONTHS rows). Test-period rows are never flagged or modified:
#    their consumption_cleaned_m3 is just consumption_m3, unchanged.
# ---------------------------------------------------------------------------
train_consumption = monthly['consumption_m3'].iloc[:TRAIN_MONTHS]
rolling_median = train_consumption.rolling(window=13, center=True, min_periods=5).median()
is_outlier_train = (train_consumption > 1.4 * rolling_median) | (train_consumption < 0.6 * rolling_median)

is_outlier = pd.Series(False, index=monthly.index)
is_outlier.iloc[:TRAIN_MONTHS] = is_outlier_train.values
monthly['is_outlier'] = is_outlier.map({True: 'yes', False: 'no'})

# Interpolate flagged months using training-period values only — never an
# anchor from the test period.
cleaned_train = train_consumption.astype(float).copy()
cleaned_train[is_outlier_train] = None
cleaned_train = cleaned_train.interpolate(method='linear')

cleaned = monthly['consumption_m3'].astype(float).copy()
cleaned.iloc[:TRAIN_MONTHS] = cleaned_train.values
monthly['consumption_cleaned_m3'] = cleaned.round().astype(int)

outlier_months = monthly.loc[is_outlier, 'date'].dt.strftime('%Y-%m').tolist()
print("Outlier detection fitted on training period only (2014-01 to 2022-06).")
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

# ---------------------------------------------------------------------------
# 8. Detail output: per (year_month, district, customer_group,
#    subscriber_type) aggregation, from the same water-only rows, excluding
#    the same dropped incomplete month. These are raw values — NO outlier
#    cleaning is applied to detail rows; only the monthly city-wide total
#    (step 6, above) is cleaned.
# ---------------------------------------------------------------------------
detail_source = kept.copy()
detail_source['ILCE'] = detail_source['ILCE'].str.strip()
detail_source['ABONELIK_GRUBU'] = detail_source['ABONELIK_GRUBU'].str.strip()
detail_source['ABONE_TIPI'] = detail_source['ABONE_TIPI'].str.strip()
detail_source['year_month'] = pd.to_datetime(
    detail_source['YIL'].astype(str) + '-' + detail_source['AY'].astype(str) + '-01'
)
detail_source = detail_source[detail_source['year_month'] < cutoff]

# From 2023-08 onward, some water rows (new "KIRSAL ..." subscriber types,
# and a few others) have an empty ABONELIK_GRUBU (customer_group). Fill
# ONLY those empty values, inferred from the subscriber type name — rows
# that already have a group are never touched. Evidence: İZSU itself labels
# 'KIRSAL E.A.(MERKEZ)' and 'KIRSAL ŞEHİT GAZİ (MERKEZ)' as Konut elsewhere
# in this same file, confirming E.A / ŞEHİT GAZİ subscriber types belong to
# the Konut (residential) group, not Konut Dışı.
NON_RESIDENTIAL_KEYWORDS = ['İŞYERİ', 'LİMAN', 'YURT', 'KÜLTÜR', 'İNŞAAT']
RESIDENTIAL_KEYWORDS = ['KONUT', 'E.A', 'BAHÇE SUYU', 'ŞEHİT GAZİ']


def infer_customer_group(subscriber_type):
    if any(kw in subscriber_type for kw in NON_RESIDENTIAL_KEYWORDS):
        return 'Konut Dışı'
    if any(kw in subscriber_type for kw in RESIDENTIAL_KEYWORDS):
        return 'Konut'
    return None


null_group_mask = detail_source['ABONELIK_GRUBU'].isna()
null_types = sorted(detail_source.loc[null_group_mask, 'ABONE_TIPI'].unique())

type_to_group = {}
for t in null_types:
    inferred = infer_customer_group(t)
    if inferred is None:
        sys.exit(
            f"ERROR: cannot infer customer_group for subscriber_type {t!r} "
            f"(ABONELIK_GRUBU is empty for it and no rule keyword matched). "
            f"Stopping rather than guessing."
        )
    type_to_group[t] = inferred

if null_types:
    fill_summary = (
        detail_source.loc[null_group_mask]
        .groupby('ABONE_TIPI')
        .agg(rows=('ABONE_TIPI', 'size'), total_m3=('ORTALAMA_TUKETIM', 'sum'))
    )
    print("\nFilled empty customer_group values from subscriber_type:")
    print(f"{'subscriber_type':<32} {'filled_group':<12} {'rows':>6} {'total_m3':>14}")
    for t in null_types:
        row = fill_summary.loc[t]
        print(f"{t:<32} {type_to_group[t]:<12} {int(row['rows']):>6} {row['total_m3']:>14,.0f}")
    print(f"Total rows filled: {int(null_group_mask.sum())}, "
          f"total m3 filled: {detail_source.loc[null_group_mask, 'ORTALAMA_TUKETIM'].sum():,.0f}")

    detail_source.loc[null_group_mask, 'ABONELIK_GRUBU'] = (
        detail_source.loc[null_group_mask, 'ABONE_TIPI'].map(type_to_group)
    )

detail = (
    detail_source.groupby(['year_month', 'ILCE', 'ABONELIK_GRUBU', 'ABONE_TIPI'])
    .agg(subscribers=('ABONE_ADEDI', 'sum'), consumption_m3=('ORTALAMA_TUKETIM', 'sum'))
    .reset_index()
    .rename(columns={'ILCE': 'district', 'ABONELIK_GRUBU': 'customer_group', 'ABONE_TIPI': 'subscriber_type'})
)
detail = detail.sort_values(['year_month', 'district', 'customer_group', 'subscriber_type']).reset_index(drop=True)
detail['subscribers'] = detail['subscribers'].astype(int)
detail['consumption_m3'] = detail['consumption_m3'].astype(int)

print(f"\nDetail rows: {len(detail)}")

# Validate: each month's detail-row consumption must sum to that month's
# monthly-total consumption_m3 (the uncleaned total from step 4, i.e.
# `monthly`'s consumption_m3 column).
detail['year_month'] = detail['year_month'].dt.strftime('%Y-%m-%d')
detail_monthly_totals = detail.groupby('year_month')['consumption_m3'].sum()
monthly_totals = monthly.set_index('date')['consumption_m3']

mismatches = []
for date, total in monthly_totals.items():
    detail_total = detail_monthly_totals.get(date)
    if detail_total != total:
        mismatches.append((date, total, detail_total))

if mismatches:
    print(f"MISMATCH: {len(mismatches)} of {len(monthly_totals)} month(s) where "
          f"detail totals don't match the monthly total:")
    for date, total, detail_total in mismatches:
        print(f"  {date}: monthly total={total}, sum of detail rows={detail_total}")

    # Diagnose: groupby() silently drops rows where any key column is null
    # (ILCE / ABONELIK_GRUBU / ABONE_TIPI), rather than raising — so a
    # mismatch here means some raw rows have a missing category, not a
    # calculation error. Report which column and how much consumption.
    null_mask = detail_source[['ILCE', 'ABONELIK_GRUBU', 'ABONE_TIPI']].isna().any(axis=1)
    if null_mask.any():
        print("\nRoot cause: rows with a null key column are silently excluded "
              "from the detail groupby (pandas default) while still counted in "
              "the monthly total. Breakdown by month and null column:")
        null_rows = detail_source[null_mask].copy()
        null_rows['year_month_str'] = null_rows['year_month'].dt.strftime('%Y-%m-%d')
        for col in ['ILCE', 'ABONELIK_GRUBU', 'ABONE_TIPI']:
            by_month = null_rows[null_rows[col].isna()].groupby('year_month_str')['ORTALAMA_TUKETIM'].agg(['count', 'sum'])
            for date, row in by_month.iterrows():
                print(f"  {date}: {col} is null on {int(row['count'])} row(s), "
                      f"totalling {row['sum']:,.0f} m3")
    sys.exit(1)
else:
    print(f"Detail totals match monthly totals for all {len(monthly_totals)} months")

detail_output = detail[
    ['year_month', 'district', 'customer_group', 'subscriber_type', 'subscribers', 'consumption_m3']
]

detail_tmp_fd, detail_tmp_path = tempfile.mkstemp(suffix='.csv')
os.close(detail_tmp_fd)
detail_output.to_csv(detail_tmp_path, index=False)
print(f"\nComputed detail output written to temporary file: {detail_tmp_path}")

# VERIFY: never overwrite an existing detail file without comparing first
if os.path.exists(DETAIL_PATH):
    with open(detail_tmp_path, newline='', encoding='utf-8') as f:
        new_detail_rows = list(csv.reader(f))
    with open(DETAIL_PATH, newline='', encoding='utf-8') as f:
        existing_detail_rows = list(csv.reader(f))

    if new_detail_rows == existing_detail_rows:
        print(f"VERIFIED: all {len(new_detail_rows) - 1} rows match the existing "
              f"{DETAIL_PATH} exactly. File left untouched.")
        os.remove(detail_tmp_path)
    else:
        print(f"MISMATCH between the computed detail output and {DETAIL_PATH}. "
              f"Existing file left untouched. Differences:")
        max_len = max(len(new_detail_rows), len(existing_detail_rows))
        diff_count = 0
        for i in range(max_len):
            new_row = new_detail_rows[i] if i < len(new_detail_rows) else None
            existing_row = existing_detail_rows[i] if i < len(existing_detail_rows) else None
            if new_row != existing_row:
                diff_count += 1
                if diff_count <= 20:
                    print(f"  Row {i}: computed={new_row!r} existing={existing_row!r}")
        print(f"\n{diff_count} differing row(s). Stopping without writing.")
        sys.exit(1)
else:
    shutil.move(detail_tmp_path, DETAIL_PATH)
    print(f"No existing file found at {DETAIL_PATH} - wrote the new output there.")
