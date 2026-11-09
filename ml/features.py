"""
Feature engineering for Experiment Protocol 2 (see
docs/experiment_protocol_2.md). Pure data-preparation functions only -- no
model fitting or evaluation here. See ml/check_features.py for validation
of everything below.
"""

import os

import holidays
import pandas as pd

WEATHER_CSV_PATH = os.path.join(os.path.dirname(__file__), 'data', 'weather_izmir_era5.csv')

# Any holiday name containing one of these substrings is a Ramazan/Kurban
# Bayramı day. The `holidays` library's "half_day" category separately
# lists each eve (Arefe) under a name such as "Ramazan Bayramı (saat
# 13.00'ten)" -- which also contains this substring -- so eve days are
# excluded two ways: by restricting to the "public" category (which does
# not include half_day entries at all in this library version) and, as a
# defensive second check in case that ever changes, by skipping any name
# containing _EVE_MARKER.
BAYRAM_NAME_SUBSTRINGS = ('Ramazan Bayramı', 'Kurban Bayramı')
_EVE_MARKER = 'saat'  # only appears in half_day (Arefe) entries


def load_weather_monthly(csv_path=WEATHER_CSV_PATH):
    """Daily ERA5 weather (ml/data/weather_izmir_era5.csv) aggregated to
    month-start (MS) frequency: temp_mean/temp_max are the mean of the
    daily mean/max temperature; precip is the monthly total precipitation.

    Raises ValueError if any day in the file's own date range is missing,
    any date is duplicated, or any of the three values is NaN.
    """
    daily = pd.read_csv(csv_path, skiprows=3)
    daily = daily.rename(columns={
        daily.columns[0]: 'date',
        daily.columns[1]: 'temp_mean',
        daily.columns[2]: 'temp_max',
        daily.columns[3]: 'precip',
    })
    daily['date'] = pd.to_datetime(daily['date'])

    duplicated = daily['date'][daily['date'].duplicated()]
    if len(duplicated) > 0:
        raise ValueError(
            f"Duplicate date(s) in {csv_path}: "
            f"{sorted(d.strftime('%Y-%m-%d') for d in duplicated.unique())}"
        )

    expected = pd.date_range(daily['date'].min(), daily['date'].max(), freq='D')
    missing = expected.difference(daily['date'])
    if len(missing) > 0:
        raise ValueError(
            f"Missing day(s) in {csv_path}: {[d.strftime('%Y-%m-%d') for d in missing]}"
        )

    value_cols = ['temp_mean', 'temp_max', 'precip']
    if daily[value_cols].isna().any().any():
        bad_rows = daily.loc[daily[value_cols].isna().any(axis=1), 'date']
        raise ValueError(
            f"NaN weather value(s) in {csv_path} on: "
            f"{[d.strftime('%Y-%m-%d') for d in bad_rows]}"
        )

    daily = daily.set_index('date').sort_index()
    monthly = daily.resample('MS').agg({'temp_mean': 'mean', 'temp_max': 'mean', 'precip': 'sum'})
    return monthly.reset_index().rename(columns={'date': 'ds'})


def weather_normals(monthly, train_end):
    """Per-calendar-month average of each weather variable, using only
    rows with ds <= train_end. Returns a DataFrame indexed by calendar
    month (1-12) with columns temp_mean/temp_max/precip -- the values used
    to fill in any "future" (post-train_end) month, since real future
    weather isn't known at forecast time.
    """
    train_end = pd.Timestamp(train_end)
    train_rows = monthly[monthly['ds'] <= train_end].copy()
    train_rows['calendar_month'] = train_rows['ds'].dt.month
    return train_rows.groupby('calendar_month')[['temp_mean', 'temp_max', 'precip']].mean()


def bayram_days_monthly(start, end):
    """Number of official Ramazan Bayramı / Kurban Bayramı days per
    calendar month, for every month overlapping [start, end]. Each date is
    counted once even when it coincides with another public holiday (e.g.
    23 April). Half-day eves (Arefe) are excluded.

    `end` is treated as inclusive of its whole calendar month -- internally
    extended to that month's last day -- so a month-start date (e.g.
    "2023-06-01") and that same month's month-end date (e.g. "2023-06-30")
    as `end` produce identical results. This matters because callers (e.g.
    build_exog) often pass a sequence of month-start dates and use its max
    as `end`; without this, any Bayram day falling after the 1st of that
    last month would be silently dropped.

    Returns a DataFrame with columns ds (month start) and bayram_days.
    """
    start = pd.Timestamp(start)
    end = pd.Timestamp(end) + pd.offsets.MonthEnd(0)
    tr = holidays.Turkey(years=range(start.year, end.year + 1), categories=('public',))

    counts = {}
    for date, name in tr.items():
        date = pd.Timestamp(date)
        if date < start or date > end:
            continue
        if _EVE_MARKER in name:
            continue
        if any(substr in name for substr in BAYRAM_NAME_SUBSTRINGS):
            month_start = date.replace(day=1)
            counts[month_start] = counts.get(month_start, 0) + 1

    months = pd.date_range(start.replace(day=1), end.replace(day=1), freq='MS')
    result = pd.DataFrame({'ds': months})
    result['bayram_days'] = result['ds'].map(lambda d: counts.get(d, 0))
    return result


def build_exog(ds, train_end, weather_mode):
    """One DataFrame of exogenous features aligned to `ds` (a sequence of
    month-start dates): temp_mean, temp_max, precip and bayram_days.

    weather_mode:
      "normals" -- any date after train_end gets weather_normals()-filled
                   values instead of the real observed value (what the
                   main E2 evaluation uses, since real future weather
                   isn't known at forecast time).
      "actual"  -- always use the real observed value (the separate
                   "best case, not achievable in practice" comparison).

    bayram_days is included under both modes -- Bayram dates are known
    years in advance, so they are never a "future unknown" the way weather
    is.
    """
    if weather_mode not in ('normals', 'actual'):
        raise ValueError(f"weather_mode must be 'normals' or 'actual', got {weather_mode!r}")

    ds = pd.DatetimeIndex(pd.to_datetime(ds))
    train_end = pd.Timestamp(train_end)

    monthly = load_weather_monthly()
    monthly_indexed = monthly.set_index('ds')
    weather_rows = monthly_indexed.reindex(ds)

    if weather_mode == 'normals':
        normals = weather_normals(monthly, train_end)
        future_mask = ds > train_end
        months_of_ds = pd.Series(ds.month, index=ds)
        for col in ('temp_mean', 'temp_max', 'precip'):
            filled = months_of_ds.map(normals[col])
            weather_rows.loc[future_mask, col] = filled.loc[future_mask]

    value_cols = ['temp_mean', 'temp_max', 'precip']
    if weather_rows[value_cols].isna().any().any():
        missing = weather_rows[weather_rows[value_cols].isna().any(axis=1)]
        raise ValueError(
            "No weather data available for: "
            f"{[d.strftime('%Y-%m-%d') for d in missing.index]}. "
            f"{WEATHER_CSV_PATH} does not cover this date range."
        )

    bayram = bayram_days_monthly(ds.min(), ds.max()).set_index('ds')
    bayram_values = bayram.reindex(ds)['bayram_days'].fillna(0).astype(int)

    result = weather_rows.reset_index().rename(columns={'index': 'ds'})
    result['bayram_days'] = bayram_values.values
    return result
