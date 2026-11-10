"""
E2/E3 (Experiment Protocol 2): Prophet (defaults) with exogenous
regressors -- weather (E2) and Bayram-day counts (E3).

Method (fixed before this script is ever run -- see
docs/experiment_protocol_2.md, "E2/E3 method details"):

  - Exactly three variants, no others, and no combined weather+Bayram
    variant in this round:
      * "E2 weather (normals)": regressors temp_mean, temp_max, precip,
        with any date after each fit's own train_end filled from
        ml/features.py's weather_normals() (the training-period-only
        per-calendar-month average) -- the main E2 result.
      * "E2 weather (actual, best case)": the same three regressors, but
        always using the real observed weather value, including for
        dates after train_end. This is labelled "best case, not
        achievable in practice" everywhere it is reported, and is
        structurally excluded from the selection rule below (see
        ELIGIBLE_FOR_SELECTION on the variant definition) -- real future
        weather is never known at forecast time, so this variant could
        never actually be deployed.
      * "E3 Bayram days": regressor bayram_days only. Bayram dates are
        calendar facts known years in advance, so there is no
        "normals vs actual" distinction for this one.
  - Prophet itself uses the same fixed settings as
    eval_common.fit_prophet_and_predict (PROPHET_DEFAULT_PARAMS,
    yearly_seasonality=True, weekly/daily seasonality both False); each
    regressor is added with model.add_regressor(name) using Prophet's own
    defaults -- no prior_scale tuning or other per-regressor
    customisation.
  - Training months always use the real observed exogenous value for
    every variant -- ml/features.py's build_exog() only substitutes
    normals for dates strictly after the train_end passed to it, and
    every training-month date is by construction <= that train_end.
  - Before trusting anything, this script runs fit_prophet_exog() with an
    EMPTY regressor list at origin 2022-06-01 and checks its 12 yhat
    values against the stored 'Prophet (defaults)' row for that origin in
    ml/results/rolling_evaluation_predictions.csv, within 0.01% relative
    tolerance. This proves fit_prophet_exog(), stripped of regressors,
    reproduces the exact Prophet (defaults) behaviour those stored
    results already used -- a reproducibility guard, not part of the
    experiments themselves.
  - 26-month test-set evaluation: each variant trains once on the 102
    training months (through 2022-06-01) and forecasts the 26 test
    months; MAE/RMSE/MAPE via eval_common.evaluate(). Compared against
    Prophet (defaults)'s stored test-set MAPE, read live from
    ml/results/sarima_test_comparison.json (never hard-coded here).
  - Rolling-origin evaluation: the same 15 origins as
    ml/rolling_evaluation.py (2022-06-01 .. 2023-08-01), horizon 12,
    training on all months up to and including each origin. Mean MAPE per
    horizon (1..12) and two-sided 80% coverage per horizon (descriptive --
    see caveat below) are computed per variant. Compared against Prophet
    (defaults)'s stored rolling results, read live from
    ml/results/rolling_evaluation_summary.json (never hard-coded here).
  - Significance: ml/significance_testing.py's dm_test() (Diebold-Mariano,
    squared-error loss, Harvey-Leybourne-Newbold correction) is run for
    each variant against Prophet (defaults)'s STORED rolling predictions,
    at horizons 1, 6 and 12. The two series are aligned by origin (and
    cross-checked by target_month) before computing errors -- never by
    list position/index.
  - Selection rule: an ELIGIBLE variant (i.e. not the "best case"
    weather-actual one) "WINS" only if it beats Prophet (defaults) on
    BOTH the 26-month test MAPE AND the h12 rolling mean MAPE
    simultaneously. The magnitude of each difference is reported
    alongside the WINS/DOES NOT WIN verdict, not just the boolean.

NOTE: the 15 rolling-origin test origins overlap (each forecasts 12
months ahead, one month apart), so they are not independent observations.
Coverage and MAPE-by-horizon figures below are therefore descriptive, the
same caveat already attached to ml/rolling_evaluation.py and
ml/conformal_calibration.py, not a formal statistical guarantee.

This script is written to be run with: py -3.13 ml/exog_experiments.py
(after ml/rolling_evaluation.py and ml/sarima_test.py have already
produced the stored result files it reads). It writes two NEW files only
(ml/results/exog_experiments.json, ml/results/exog_rolling_predictions.csv)
and never modifies any existing file in ml/results/, nor
ml/eval_common.py, nor ml/features.py.
"""

import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from prophet import Prophet

from eval_common import (
    PROPHET_DEFAULT_PARAMS,
    RANDOM_SEED,
    TEST_MONTHS,
    TRAIN_MONTHS,
    ensure_results_dir,
    evaluate,
    load_consumption_df,
)
from features import build_exog
from significance_testing import dm_test

ROLLING_HORIZON = 12
ROLLING_ORIGIN_START = '2022-06-01'
ROLLING_ORIGIN_END = '2023-08-01'
DM_HORIZONS = (1, 6, 12)

CONSISTENCY_CHECK_ORIGIN = '2022-06-01'
CONSISTENCY_TOLERANCE_PCT = 0.01  # relative tolerance, percent

RESULTS_DIR = os.path.join(os.path.dirname(__file__), 'results')
ROLLING_PREDICTIONS_PATH = os.path.join(RESULTS_DIR, 'rolling_evaluation_predictions.csv')
ROLLING_SUMMARY_PATH = os.path.join(RESULTS_DIR, 'rolling_evaluation_summary.json')
SARIMA_TEST_COMPARISON_PATH = os.path.join(RESULTS_DIR, 'sarima_test_comparison.json')

BASELINE_MODEL_NAME = 'Prophet (defaults)'

# Exactly three variants. The weather-actual variant is flagged ineligible
# for the selection rule structurally (not just by comment) -- real future
# weather is never known at forecast time, so it could never be deployed.
VARIANTS = [
    {
        'name': 'E2 weather (normals)',
        'regressors': ['temp_mean', 'temp_max', 'precip'],
        'weather_mode': 'normals',
        'note': None,
        'eligible_for_selection': True,
    },
    {
        'name': 'E2 weather (actual, best case)',
        'regressors': ['temp_mean', 'temp_max', 'precip'],
        'weather_mode': 'actual',
        'note': 'best case, not achievable in practice',
        'eligible_for_selection': False,
    },
    {
        'name': 'E3 Bayram days',
        'regressors': ['bayram_days'],
        # weather_mode is irrelevant here (no weather regressor is used),
        # but build_exog() requires a valid value -- "normals" is used
        # arbitrarily and has zero effect on the bayram_days column.
        'weather_mode': 'normals',
        'note': None,
        'eligible_for_selection': True,
    },
]


def display_name(variant):
    if variant['note']:
        return f"{variant['name']} -- {variant['note']}"
    return variant['name']


def rolling_origins():
    origins = pd.date_range(ROLLING_ORIGIN_START, ROLLING_ORIGIN_END, freq='MS')
    assert len(origins) == 15, (
        f"Expected 15 rolling origins ({ROLLING_ORIGIN_START}..{ROLLING_ORIGIN_END}), got {len(origins)}."
    )
    return origins


def find_origin_index(df, origin_date):
    matches = df.index[df['ds'] == pd.Timestamp(origin_date)]
    if len(matches) == 0:
        raise SystemExit(f"ERROR: origin {origin_date} not found in the consumption series.")
    return int(matches[0])


def exog_for_variant(variant, train_ds, future_ds, train_end):
    """Returns (exog_train, exog_future) -- each a DataFrame with columns
    ds + the variant's regressor names -- built from a single build_exog()
    call spanning the whole train+future date range, then split. Training
    dates are always <= train_end, so they get the real observed value
    regardless of weather_mode (build_exog()'s own guarantee); only future
    dates can be normals-filled, and only when weather_mode == 'normals'.
    """
    regressors = variant['regressors']
    if not regressors:
        return (
            pd.DataFrame({'ds': pd.to_datetime(train_ds)}),
            pd.DataFrame({'ds': pd.to_datetime(future_ds)}),
        )

    all_ds = pd.DatetimeIndex(
        sorted(set(pd.to_datetime(train_ds)) | set(pd.to_datetime(future_ds)))
    )
    full = build_exog(all_ds, train_end, variant['weather_mode'])[['ds'] + regressors]

    train_ds_set = set(pd.to_datetime(train_ds))
    exog_train = full[full['ds'].isin(train_ds_set)].reset_index(drop=True)
    exog_future = full[~full['ds'].isin(train_ds_set)].reset_index(drop=True)
    return exog_train, exog_future


def fit_prophet_exog(train_df, regressors, future_ds, exog_train, exog_future):
    """Prophet (defaults) with the given regressors added via
    model.add_regressor() (Prophet's own defaults, no tuning). Seeds numpy
    with RANDOM_SEED immediately before predict(), matching
    eval_common.fit_prophet_and_predict's exact seeding point. With
    regressors == [], this reproduces fit_prophet_and_predict's behaviour
    exactly (same Prophet construction, same future-dataframe construction,
    same seed placement) -- this is what the consistency check relies on.

    train_df: columns ds, y.
    future_ds: the target dates to forecast (length = periods).
    exog_train / exog_future: DataFrames with columns ds + regressor
    names, aligned to train_df['ds'] / future_ds respectively.

    Returns (yhat, yhat_lower, yhat_upper) arrays, length len(future_ds).
    """
    model = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=False,
        daily_seasonality=False,
        **PROPHET_DEFAULT_PARAMS,
    )
    for name in regressors:
        model.add_regressor(name)

    if regressors:
        fit_df = train_df.merge(exog_train[['ds'] + list(regressors)], on='ds', how='left')
        missing = fit_df.loc[fit_df[list(regressors)].isna().any(axis=1), 'ds']
        if len(missing) > 0:
            raise ValueError(
                f"Missing regressor value(s) for training date(s): "
                f"{[d.strftime('%Y-%m-%d') for d in missing]}"
            )
    else:
        fit_df = train_df.copy()

    model.fit(fit_df)

    periods = len(future_ds)
    future = model.make_future_dataframe(periods=periods, freq='MS')

    if regressors:
        exog_all = pd.concat(
            [exog_train[['ds'] + list(regressors)], exog_future[['ds'] + list(regressors)]],
            ignore_index=True,
        ).drop_duplicates('ds', keep='last')
        future = future.merge(exog_all, on='ds', how='left')
        missing = future.loc[future[list(regressors)].isna().any(axis=1), 'ds']
        if len(missing) > 0:
            raise ValueError(
                f"Missing regressor value(s) for date(s): "
                f"{[d.strftime('%Y-%m-%d') for d in missing]}"
            )

    np.random.seed(RANDOM_SEED)
    forecast = model.predict(future)
    tail = forecast.tail(periods)[['ds', 'yhat', 'yhat_lower', 'yhat_upper']].reset_index(drop=True)
    return tail['yhat'].values, tail['yhat_lower'].values, tail['yhat_upper'].values


def run_consistency_check(df):
    """Runs fit_prophet_exog() with NO regressors at
    CONSISTENCY_CHECK_ORIGIN and checks the 12 yhat values against the
    stored 'Prophet (defaults)' rows for that origin in
    rolling_evaluation_predictions.csv, within CONSISTENCY_TOLERANCE_PCT
    relative tolerance. Stops with a clear error on any mismatch."""
    if not os.path.exists(ROLLING_PREDICTIONS_PATH):
        raise SystemExit(
            f"ERROR: {ROLLING_PREDICTIONS_PATH} not found. Run ml/rolling_evaluation.py first."
        )

    stored = pd.read_csv(ROLLING_PREDICTIONS_PATH)
    stored_rows = stored[
        (stored['origin'] == CONSISTENCY_CHECK_ORIGIN) & (stored['model'] == BASELINE_MODEL_NAME)
    ].sort_values('horizon')

    if len(stored_rows) != ROLLING_HORIZON:
        raise SystemExit(
            f"ERROR: expected {ROLLING_HORIZON} stored '{BASELINE_MODEL_NAME}' rows for origin "
            f"{CONSISTENCY_CHECK_ORIGIN}, found {len(stored_rows)}."
        )

    origin_index = find_origin_index(df, CONSISTENCY_CHECK_ORIGIN)
    train_df = df.iloc[:origin_index + 1][['ds', 'y']].reset_index(drop=True)
    future_ds = df.iloc[origin_index + 1: origin_index + 1 + ROLLING_HORIZON]['ds'].values

    refit_yhat, _, _ = fit_prophet_exog(train_df, [], future_ds, pd.DataFrame({'ds': []}), pd.DataFrame({'ds': []}))
    stored_yhat = stored_rows['yhat'].values

    mismatches = []
    for h in range(ROLLING_HORIZON):
        rel_diff_pct = abs(refit_yhat[h] - stored_yhat[h]) / abs(stored_yhat[h]) * 100
        if rel_diff_pct > CONSISTENCY_TOLERANCE_PCT:
            mismatches.append((h + 1, stored_yhat[h], refit_yhat[h], rel_diff_pct))

    if mismatches:
        lines = [
            f"  horizon {h}: stored yhat={sv:.4f}, refit yhat={rv:.4f}, relative diff={rd:.6f}%"
            for h, sv, rv, rd in mismatches
        ]
        raise SystemExit(
            f"ERROR: fit_prophet_exog() with no regressors, refit at origin "
            f"{CONSISTENCY_CHECK_ORIGIN}, does not match the stored "
            f"rolling_evaluation_predictions.csv values within {CONSISTENCY_TOLERANCE_PCT}% "
            f"relative tolerance:\n" + "\n".join(lines) +
            "\nStopping -- fit_prophet_exog() cannot be trusted to reproduce Prophet (defaults) "
            "without this check passing. Do not proceed with the E2/E3 experiments below."
        )

    max_rel_diff_pct = float(np.max(np.abs(refit_yhat - stored_yhat) / np.abs(stored_yhat) * 100))
    return {
        'origin': CONSISTENCY_CHECK_ORIGIN,
        'tolerance_pct': CONSISTENCY_TOLERANCE_PCT,
        'max_relative_diff_pct': max_rel_diff_pct,
        'passed': True,
    }


def run_test_set_evaluation(df, variant):
    train_df = df.iloc[:TRAIN_MONTHS][['ds', 'y']].reset_index(drop=True)
    test_df = df.iloc[TRAIN_MONTHS:TRAIN_MONTHS + TEST_MONTHS][['ds', 'y']].reset_index(drop=True)
    assert len(test_df) == TEST_MONTHS, f"Expected {TEST_MONTHS} test months, got {len(test_df)}."

    train_end = train_df['ds'].max()
    assert train_end == pd.Timestamp('2022-06-01'), (
        f"Expected the {TRAIN_MONTHS}-month training period to end at 2022-06-01, got {train_end.date()}."
    )
    exog_train, exog_future = exog_for_variant(variant, train_df['ds'], test_df['ds'], train_end)
    yhat, _, _ = fit_prophet_exog(train_df, variant['regressors'], test_df['ds'].values, exog_train, exog_future)

    return evaluate(yhat, test_df['y'].values)


def run_rolling_evaluation(df, variant):
    """Trains the variant fresh at each of the 15 rolling origins and
    forecasts 12 months ahead. Returns a list of row dicts: origin,
    horizon, target_month, model, actual, yhat, lower, upper."""
    records = []
    for origin_date in rolling_origins():
        origin_index = find_origin_index(df, origin_date)
        train_df = df.iloc[:origin_index + 1][['ds', 'y']].reset_index(drop=True)
        targets = df.iloc[origin_index + 1: origin_index + 1 + ROLLING_HORIZON]
        if len(targets) < ROLLING_HORIZON:
            raise SystemExit(
                f"ERROR: origin {origin_date.date()} does not have {ROLLING_HORIZON} months of "
                f"target data available ({len(targets)} found)."
            )
        target_dates = targets['ds'].reset_index(drop=True)
        target_actuals = targets['y'].reset_index(drop=True)

        train_end = train_df['ds'].max()
        exog_train, exog_future = exog_for_variant(variant, train_df['ds'], target_dates, train_end)
        yhat, lower, upper = fit_prophet_exog(
            train_df, variant['regressors'], target_dates.values, exog_train, exog_future
        )

        for h in range(ROLLING_HORIZON):
            records.append({
                'origin': origin_date.strftime('%Y-%m-%d'),
                'horizon': h + 1,
                'target_month': pd.Timestamp(target_dates.iloc[h]).strftime('%Y-%m-%d'),
                'model': variant['name'],
                'actual': float(target_actuals.iloc[h]),
                'yhat': float(yhat[h]),
                'lower': float(lower[h]),
                'upper': float(upper[h]),
            })
    return records


def summarize_rolling(records_df, model_name):
    """Per-horizon mean MAPE, two-sided 80% coverage and n, plus the
    averages across h1..h12, for one model's rows."""
    rows = records_df[records_df['model'] == model_name].copy()
    rows['abs_pct_error'] = np.abs((rows['actual'] - rows['yhat']) / rows['actual']) * 100
    rows['two_sided'] = (rows['actual'] >= rows['lower']) & (rows['actual'] <= rows['upper'])

    by_horizon = {}
    for h, group in rows.groupby('horizon'):
        by_horizon[int(h)] = {
            'mape': float(group['abs_pct_error'].mean()),
            'two_sided_coverage_pct': float(group['two_sided'].mean() * 100),
            'n': int(len(group)),
        }

    average = {
        'mape': float(np.mean([v['mape'] for v in by_horizon.values()])),
        'two_sided_coverage_pct': float(np.mean([v['two_sided_coverage_pct'] for v in by_horizon.values()])),
    }
    return by_horizon, average


def aligned_errors_vs_stored(own_df, variant_name, stored_df, horizon):
    """Errors (actual - yhat) for `variant_name` in own_df and for
    BASELINE_MODEL_NAME in the stored rolling predictions, aligned by
    origin (and cross-checked by target_month, not just assumed) --
    never by list position/index. Returns (e_variant, e_baseline), both
    ordered by origin."""
    own_rows = own_df[(own_df['model'] == variant_name) & (own_df['horizon'] == horizon)][
        ['origin', 'target_month', 'actual', 'yhat']
    ].rename(columns={'target_month': 'target_month_own', 'actual': 'actual_own', 'yhat': 'yhat_own'})

    stored_rows = stored_df[(stored_df['model'] == BASELINE_MODEL_NAME) & (stored_df['horizon'] == horizon)][
        ['origin', 'target_month', 'actual', 'yhat']
    ].rename(columns={'target_month': 'target_month_stored', 'actual': 'actual_stored', 'yhat': 'yhat_stored'})

    merged = own_rows.merge(stored_rows, on='origin', how='inner').sort_values('origin').reset_index(drop=True)

    if len(merged) != len(own_rows) or len(merged) != len(stored_rows):
        raise ValueError(
            f"Origin alignment mismatch for {variant_name!r} vs {BASELINE_MODEL_NAME!r} at horizon "
            f"{horizon}: {len(own_rows)} own rows, {len(stored_rows)} stored rows, {len(merged)} merged."
        )
    mismatched_targets = merged[merged['target_month_own'] != merged['target_month_stored']]
    if len(mismatched_targets) > 0:
        raise ValueError(
            f"Target-month mismatch after aligning by origin for {variant_name!r} vs "
            f"{BASELINE_MODEL_NAME!r} at horizon {horizon}: origins "
            f"{mismatched_targets['origin'].tolist()}"
        )

    e_variant = (merged['actual_own'] - merged['yhat_own']).values
    e_baseline = (merged['actual_stored'] - merged['yhat_stored']).values
    return e_variant, e_baseline


def main():
    np.random.seed(RANDOM_SEED)

    print("=== E2/E3: Prophet (defaults) with exogenous regressors (weather, Bayram days) ===")

    df = load_consumption_df()

    print(f"\nConsistency check: fit_prophet_exog() with no regressors, refit at origin "
          f"{CONSISTENCY_CHECK_ORIGIN}, compared to the stored rolling-evaluation forecast...")
    consistency_result = run_consistency_check(df)
    print(
        f"  PASS -- max relative difference {consistency_result['max_relative_diff_pct']:.6f}% "
        f"(tolerance {CONSISTENCY_TOLERANCE_PCT}%)"
    )

    if not os.path.exists(SARIMA_TEST_COMPARISON_PATH):
        raise SystemExit(f"ERROR: {SARIMA_TEST_COMPARISON_PATH} not found. Run ml/sarima_test.py first.")
    with open(SARIMA_TEST_COMPARISON_PATH) as f:
        sarima_test_comparison = json.load(f)
    baseline_test_mape = sarima_test_comparison['metrics'][BASELINE_MODEL_NAME]['mape']

    if not os.path.exists(ROLLING_SUMMARY_PATH):
        raise SystemExit(f"ERROR: {ROLLING_SUMMARY_PATH} not found. Run ml/rolling_evaluation.py first.")
    with open(ROLLING_SUMMARY_PATH) as f:
        rolling_summary = json.load(f)
    baseline_h12_mape = rolling_summary['mape_by_horizon'][BASELINE_MODEL_NAME]['12']

    stored_rolling = pd.read_csv(ROLLING_PREDICTIONS_PATH)

    print(f"\nStored baseline ({BASELINE_MODEL_NAME}): 26-month test MAPE={baseline_test_mape:.3f}%, "
          f"h12 rolling mean MAPE={baseline_h12_mape:.3f}% (both read live from stored results)")

    all_variant_results = {}
    all_rolling_records = []

    for variant in VARIANTS:
        print(f"\n--- {display_name(variant)} ---")

        print("  26-month test evaluation...")
        test_metrics = run_test_set_evaluation(df, variant)
        print(f"    MAE={test_metrics['mae']:.1f}  RMSE={test_metrics['rmse']:.1f}  MAPE={test_metrics['mape']:.3f}%")

        print(f"  Rolling-origin evaluation ({ROLLING_ORIGIN_START} .. {ROLLING_ORIGIN_END}, 15 origins)...")
        records = run_rolling_evaluation(df, variant)
        all_rolling_records.extend(records)
        records_df = pd.DataFrame.from_records(records)
        by_horizon, average = summarize_rolling(records_df, variant['name'])
        print(
            f"    rolling avg: MAPE={average['mape']:.3f}%  two-sided coverage={average['two_sided_coverage_pct']:.1f}%  "
            f"h12 MAPE={by_horizon[12]['mape']:.3f}%"
        )

        dm_results = {}
        for h in DM_HORIZONS:
            e_variant, e_baseline = aligned_errors_vs_stored(records_df, variant['name'], stored_rolling, h)
            dm_stat, p_value = dm_test(e_variant, e_baseline, h)
            dm_results[h] = {'n': len(e_variant), 'dm_statistic': dm_stat, 'p_value': p_value}
            if isinstance(p_value, str):
                print(f"    DM vs {BASELINE_MODEL_NAME} h={h}: not computable")
            else:
                sig = '*' if p_value < 0.05 else ''
                print(f"    DM vs {BASELINE_MODEL_NAME} h={h}: DM={dm_stat:>7.3f}  p={p_value:.4f} {sig}")

        all_variant_results[variant['name']] = {
            'test_metrics': test_metrics,
            'rolling_by_horizon': {str(h): v for h, v in by_horizon.items()},
            'rolling_average': average,
            'dm_vs_baseline': {str(h): v for h, v in dm_results.items()},
        }

    print("\n=== Selection rule ===")
    print(f"An eligible variant WINS only if it beats {BASELINE_MODEL_NAME} on BOTH the 26-month "
          "test MAPE AND the h12 rolling mean MAPE.")
    selection_outcomes = {}
    for variant in VARIANTS:
        name = variant['name']
        if not variant['eligible_for_selection']:
            print(f"  {display_name(variant)}: EXCLUDED from selection (not achievable in practice)")
            continue

        variant_test_mape = all_variant_results[name]['test_metrics']['mape']
        variant_h12_mape = all_variant_results[name]['rolling_by_horizon']['12']['mape']
        test_diff = baseline_test_mape - variant_test_mape    # positive = variant better
        h12_diff = baseline_h12_mape - variant_h12_mape        # positive = variant better
        wins = (variant_test_mape < baseline_test_mape) and (variant_h12_mape < baseline_h12_mape)

        verdict = 'WINS' if wins else 'DOES NOT WIN'
        print(
            f"  {name}: {verdict}  "
            f"(test MAPE {variant_test_mape:.3f}% vs baseline {baseline_test_mape:.3f}%, "
            f"diff={test_diff:+.3f}pp; h12 rolling MAPE {variant_h12_mape:.3f}% vs baseline "
            f"{baseline_h12_mape:.3f}%, diff={h12_diff:+.3f}pp)"
        )
        selection_outcomes[name] = {
            'wins': bool(wins),
            'test_mape_pct': variant_test_mape,
            'baseline_test_mape_pct': baseline_test_mape,
            'test_mape_diff_pp': test_diff,
            'h12_rolling_mape_pct': variant_h12_mape,
            'baseline_h12_rolling_mape_pct': baseline_h12_mape,
            'h12_rolling_mape_diff_pp': h12_diff,
        }

    # --- Write output files (new files only). ---
    results_dir = ensure_results_dir()

    rolling_df = pd.DataFrame.from_records(all_rolling_records)
    rolling_df = rolling_df[['origin', 'horizon', 'target_month', 'model', 'actual', 'yhat', 'lower', 'upper']]
    assert len(rolling_df) == len(VARIANTS) * 15 * ROLLING_HORIZON, (
        f"Expected {len(VARIANTS) * 15 * ROLLING_HORIZON} rolling prediction rows, got {len(rolling_df)}."
    )
    rolling_df.to_csv(os.path.join(results_dir, 'exog_rolling_predictions.csv'), index=False)

    run_timestamp = datetime.now(timezone.utc).isoformat()
    payload = {
        'method': (
            "Prophet (defaults) with exogenous regressors added via model.add_regressor() "
            "(Prophet's own defaults, no prior_scale tuning). Three variants: E2 weather "
            "(normals), E2 weather (actual, best case -- ineligible for selection), and E3 "
            "Bayram days. Training months always use the real observed exogenous value; "
            "'normals'-mode future months are filled from ml/features.py's weather_normals(), "
            "computed from training-period-only months. Baseline comparison numbers "
            f"({BASELINE_MODEL_NAME}'s test MAPE and h12 rolling MAPE) are read live from "
            "the stored Protocol 1 result files, never hard-coded."
        ),
        'variants': [
            {
                'name': v['name'],
                'regressors': v['regressors'],
                'weather_mode': v['weather_mode'],
                'note': v['note'],
                'eligible_for_selection': v['eligible_for_selection'],
            }
            for v in VARIANTS
        ],
        'consistency_check': consistency_result,
        'baseline': {
            'model': BASELINE_MODEL_NAME,
            'test_mape_pct': baseline_test_mape,
            'h12_rolling_mape_pct': baseline_h12_mape,
            'source': {
                'test_mape': os.path.relpath(SARIMA_TEST_COMPARISON_PATH, os.path.dirname(os.path.dirname(__file__))),
                'h12_rolling_mape': os.path.relpath(ROLLING_SUMMARY_PATH, os.path.dirname(os.path.dirname(__file__))),
            },
        },
        'results_by_variant': all_variant_results,
        'selection_rule': (
            "An eligible variant WINS only if it beats Prophet (defaults) on BOTH the "
            "26-month test MAPE AND the h12 rolling mean MAPE simultaneously."
        ),
        'selection_outcomes': selection_outcomes,
        'overlapping_origins_caveat': (
            "The 15 rolling origins overlap (each forecasts 12 months ahead, one month apart), "
            "so they are not independent observations; coverage, MAPE-by-horizon and DM results "
            "above are descriptive, not a formal statistical guarantee."
        ),
        'run_timestamp': run_timestamp,
    }
    with open(os.path.join(results_dir, 'exog_experiments.json'), 'w') as f:
        json.dump(payload, f, indent=2)

    print(f"\nWrote {os.path.join(results_dir, 'exog_rolling_predictions.csv')}")
    print(f"Wrote {os.path.join(results_dir, 'exog_experiments.json')}")


if __name__ == '__main__':
    main()
