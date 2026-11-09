"""
Validation script for ml/features.py (Experiment Protocol 2). Reads only
ml/data/weather_izmir_era5.csv and the `holidays` library -- no database
access, no model fitting or evaluation. Prints a pass/fail report for every
check and exits non-zero if any check fails.

Run with: python ml/check_features.py
"""

import sys

import pandas as pd

from features import (
    WEATHER_CSV_PATH,
    bayram_days_monthly,
    build_exog,
    load_weather_monthly,
    weather_normals,
)

RESULTS = []


def record(name, ok, detail=''):
    RESULTS.append((name, ok, detail))
    status = 'PASS' if ok else 'FAIL'
    suffix = f' -- {detail}' if detail else ''
    print(f'[{status}] {name}{suffix}')


def check_weather_coverage():
    raw = pd.read_csv(WEATHER_CSV_PATH, skiprows=3)
    raw = raw.rename(columns={raw.columns[0]: 'date'})
    raw['date'] = pd.to_datetime(raw['date'])

    n_days = len(raw)
    record('weather file has 4,687 days', n_days == 4687, f'got {n_days}')

    start, end = raw['date'].min(), raw['date'].max()
    record(
        'weather file spans 2014-01-01 to 2026-10-31',
        start == pd.Timestamp('2014-01-01') and end == pd.Timestamp('2026-10-31'),
        f'got {start.date()} to {end.date()}',
    )

    expected_days = pd.date_range(start, end, freq='D')
    missing = expected_days.difference(raw['date'])
    record('no missing days in the weather file', len(missing) == 0, f'{len(missing)} missing')

    value_cols = [c for c in raw.columns if c != 'date']
    n_nan = int(raw[value_cols].isna().sum().sum())
    record('no NaN values in the weather file', n_nan == 0, f'{n_nan} NaN cells')

    try:
        monthly = load_weather_monthly()
        record('load_weather_monthly() produces 154 months', len(monthly) == 154, f'got {len(monthly)}')
    except Exception as exc:  # noqa: BLE001 -- surfaced as a failed check, not a crash
        record('load_weather_monthly() produces 154 months', False, f'raised {exc!r}')
        monthly = None

    return monthly


def check_normals_ignore_future_data(monthly):
    if monthly is None:
        record('weather_normals(train_end=2022-06) ignores post-cutoff data', False, 'skipped: monthly load failed')
        return

    train_end = pd.Timestamp('2022-06-01')

    original_normals = weather_normals(monthly, train_end)

    # A copy of the monthly data with every value strictly after train_end
    # altered, to prove weather_normals is genuinely insensitive to it --
    # not just inspected by eye. The real file/DataFrame is never touched.
    tampered = monthly.copy()
    future_mask = tampered['ds'] > train_end
    tampered.loc[future_mask, ['temp_mean', 'temp_max', 'precip']] = 9999.0

    tampered_normals = weather_normals(tampered, train_end)

    unchanged = original_normals.equals(tampered_normals)
    record(
        'weather_normals(train_end=2022-06) ignores post-cutoff data',
        unchanged,
        'normals changed after altering post-cutoff rows' if not unchanged else '',
    )


def check_bayram_spot_checks():
    expected_by_year_month = {
        (2015, 7): 3,   # Ramazan 17-19 Jul 2015
        (2015, 9): 4,   # Kurban 24-27 Sep 2015
        (2020, 7): 1,   # Kurban 31 Jul 2020 (1 day in July)
        (2020, 8): 3,   # Kurban 1-3 Aug 2020 (3 days in August)
        (2022, 5): 3,   # Ramazan 2-4 May 2022
        (2022, 7): 4,   # Kurban 9-12 Jul 2022
        (2024, 4): 3,   # Ramazan 10-12 Apr 2024
        (2024, 6): 4,   # Kurban 16-19 Jun 2024
        (2026, 3): 3,   # Ramazan 20-22 Mar 2026
    }

    years = sorted({year for year, _ in expected_by_year_month})
    for year in years:
        monthly_counts = bayram_days_monthly(f'{year}-01-01', f'{year}-12-31')
        counts_by_month = dict(zip(monthly_counts['ds'].dt.month, monthly_counts['bayram_days']))
        for (y, month), expected_count in expected_by_year_month.items():
            if y != year:
                continue
            actual_count = counts_by_month.get(month)
            record(
                f'bayram_days_monthly: {y}-{month:02d} has {expected_count} Bayram day(s)',
                actual_count == expected_count,
                f'got {actual_count}',
            )


def check_training_months_with_bayram_day():
    training = bayram_days_monthly('2014-01-01', '2022-06-30')
    record('bayram_days_monthly covers the 102 training months', len(training) == 102, f'got {len(training)} months')

    n_with_bayram = int((training['bayram_days'] > 0).sum())
    record(
        '18 of the 102 training months (2014-01..2022-06) contain a Bayram day',
        n_with_bayram == 18,
        f'got {n_with_bayram}',
    )


def check_bayram_month_end_inclusive():
    # Regression check: build_exog passes ds.max() (a month-START date) as
    # `end` -- bayram_days_monthly must treat that as covering the whole
    # of that last month, not just its 1st, so a month-start `end` and that
    # same month's month-end `end` must agree.
    by_month_start_end = bayram_days_monthly('2023-04-01', '2023-06-01')
    counts = dict(zip(by_month_start_end['ds'].dt.month, by_month_start_end['bayram_days']))
    june_count = counts.get(6)
    record(
        "bayram_days_monthly('2023-04-01', '2023-06-01') gives June 2023 = 3",
        june_count == 3,
        f'got {june_count}',
    )

    by_month_end_end = bayram_days_monthly('2023-04-01', '2023-06-30')
    counts_month_end = dict(zip(by_month_end_end['ds'].dt.month, by_month_end_end['bayram_days']))
    agree = counts == counts_month_end
    record(
        "bayram_days_monthly agrees whether `end` is given as a month-start or that month's month-end",
        agree,
        f'month-start end={counts}, month-end end={counts_month_end}' if not agree else '',
    )


def check_build_exog_bayram_days():
    ds = pd.date_range('2023-04-01', '2023-06-01', freq='MS')
    exog = build_exog(ds, train_end='2022-06-01', weather_mode='normals')
    by_ds = dict(zip(exog['ds'], exog['bayram_days']))
    expected = {
        pd.Timestamp('2023-04-01'): 3,
        pd.Timestamp('2023-05-01'): 0,
        pd.Timestamp('2023-06-01'): 3,
    }
    for ds_val, expected_count in expected.items():
        actual_count = by_ds.get(ds_val)
        record(
            f"build_exog bayram_days for {ds_val.strftime('%Y-%m')} is {expected_count}",
            actual_count == expected_count,
            f'got {actual_count}',
        )


def check_build_exog_normals_vs_actual():
    ds = pd.date_range('2022-01-01', '2022-12-01', freq='MS')
    train_end = pd.Timestamp('2022-06-01')

    normals_exog = build_exog(ds, train_end=train_end, weather_mode='normals')
    actual_exog = build_exog(ds, train_end=train_end, weather_mode='actual')

    value_cols = ['temp_mean', 'temp_max', 'precip']
    past_mask = normals_exog['ds'] <= train_end
    future_mask = ~past_mask

    past_identical = normals_exog.loc[past_mask, value_cols].equals(actual_exog.loc[past_mask, value_cols])
    record(
        'build_exog: rows up to and including train_end are identical under "normals" and "actual"',
        past_identical,
        '' if past_identical else 'values differ on or before 2022-06',
    )

    monthly = load_weather_monthly()
    normals_table = weather_normals(monthly, train_end)
    expected_future_normals = normals_exog.loc[future_mask, 'ds'].dt.month.map(
        lambda m: normals_table.loc[m]
    )
    future_matches_normals = all(
        normals_exog.loc[future_mask, col].reset_index(drop=True).round(6).equals(
            pd.Series([expected_future_normals.iloc[i][col] for i in range(len(expected_future_normals))]).round(6)
        )
        for col in value_cols
    )
    record(
        'build_exog: rows after train_end equal weather_normals() under "normals" mode',
        future_matches_normals,
        '' if future_matches_normals else 'post-cutoff rows do not match weather_normals()',
    )

    monthly_indexed = monthly.set_index('ds')
    observed_future = monthly_indexed.reindex(ds[future_mask])[value_cols].reset_index(drop=True)
    actual_future = actual_exog.loc[future_mask, value_cols].reset_index(drop=True)
    future_matches_actual = observed_future.round(6).equals(actual_future.round(6))
    record(
        'build_exog: rows after train_end equal the real observed values under "actual" mode',
        future_matches_actual,
        '' if future_matches_actual else 'post-cutoff rows do not match the observed monthly values',
    )


def check_build_exog_rejects_bad_mode():
    ds = pd.date_range('2022-01-01', '2022-03-01', freq='MS')
    try:
        build_exog(ds, train_end='2022-01-01', weather_mode='bogus')
        record("build_exog raises ValueError for an invalid weather_mode", False, 'no exception raised')
    except ValueError as exc:
        record("build_exog raises ValueError for an invalid weather_mode", True, str(exc))
    except Exception as exc:  # noqa: BLE001 -- wrong exception type is still a failed check
        record("build_exog raises ValueError for an invalid weather_mode", False, f'raised {exc!r} instead')


def main():
    print('=== Weather data ===')
    monthly = check_weather_coverage()

    print('\n=== weather_normals train_end insensitivity ===')
    check_normals_ignore_future_data(monthly)

    print('\n=== Bayram day spot-checks ===')
    check_bayram_spot_checks()

    print('\n=== Training-period Bayram coverage ===')
    check_training_months_with_bayram_day()

    print('\n=== bayram_days_monthly month-end-inclusive `end` (regression) ===')
    check_bayram_month_end_inclusive()

    print('\n=== build_exog bayram_days alignment ===')
    check_build_exog_bayram_days()

    print('\n=== build_exog "normals" vs "actual" weather_mode ===')
    check_build_exog_normals_vs_actual()

    print('\n=== build_exog invalid weather_mode ===')
    check_build_exog_rejects_bad_mode()

    n_total = len(RESULTS)
    n_passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f'\n{n_passed}/{n_total} checks passed.')

    if n_passed != n_total:
        print('FAILED checks:')
        for name, ok, detail in RESULTS:
            if not ok:
                print(f'  - {name}{": " + detail if detail else ""}')
        sys.exit(1)


if __name__ == '__main__':
    main()
