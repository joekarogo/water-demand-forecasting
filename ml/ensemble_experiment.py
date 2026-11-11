"""
E4 (Experiment Protocol 2): equal 50/50 ensemble average of Prophet
(defaults) and the chosen SARIMA setting. No weight tuning. Point
forecasts only -- this experiment defines NO ensemble prediction
interval (see "no ensemble interval" note below).

Method (fixed before this script is ever run -- see
docs/experiment_protocol_2.md, "E4 method details"):

  - Weights are fixed at 0.5 / 0.5, with no tuning of any kind.
  - Rolling-origin ensemble: built entirely from the forecasts already
    stored in ml/results/rolling_evaluation_predictions.csv for
    'Prophet (defaults)' and the chosen SARIMA (whose label string is
    resolved from ml/results/rolling_evaluation_summary.json's
    sarima_label field at runtime, never hard-coded) -- no new Prophet or
    SARIMA fitting is done for this part. The two series are aligned by
    (origin, horizon), with explicit checks that both cover the same 15
    origins x 12 horizons and that every aligned pair shares the same
    target_month and the same actual (a mismatch there would indicate a
    serious problem with the stored data, not just a minor discrepancy).
    ensemble_yhat = 0.5 * prophet_yhat + 0.5 * sarima_yhat.
  - Before trusting that recomputation, Prophet's and SARIMA's own mean
    MAPE-by-horizon, recomputed here directly from the raw CSV, is
    checked against ml/results/rolling_evaluation_summary.json's
    mape_by_horizon, within 0.001 percentage points.
  - 26-month test-set ensemble: SARIMA's test forecast comes from the
    already-stored ml/results/sarima_test_predictions.csv. Prophet
    (defaults) has no stored test-set forecast anywhere, so it is refit
    EXACTLY ONCE here (eval_common.fit_prophet_and_predict,
    PROPHET_DEFAULT_PARAMS, periods=26, on the 102 training months) --
    and the resulting MAPE is checked against
    ml/results/sarima_test_comparison.json's stored Prophet (defaults)
    MAPE, within 0.001 percentage points, before anything built on this
    refit is trusted. The refit's own dates and actual values are also
    checked against sarima_test_predictions.csv's dates/actuals, to rule
    out any date-alignment mismatch between the two sources.
  - Significance: ml/significance_testing.py's dm_test() (Diebold-Mariano,
    squared-error loss, Harvey-Leybourne-Newbold correction), for
    Ensemble vs Prophet (defaults) and Ensemble vs SARIMA, at horizons 1,
    6 and 12, on the same origin-aligned rolling errors used above.
    "not computable" is reported exactly as dm_test() returns it (seen at
    h=12 in the earlier E2/E3 run on this branch), never suppressed.
  - Selection rule: the Ensemble "WINS" only if it beats Prophet
    (defaults) on BOTH the 26-month test MAPE AND the h12 rolling mean
    MAPE simultaneously, with both baseline numbers read live from the
    stored result files (never hard-coded here). The magnitude of each
    difference is reported alongside the WINS/DOES NOT WIN verdict.
  - NO ENSEMBLE PREDICTION INTERVAL is produced or reported anywhere in
    this experiment -- averaging two point forecasts says nothing about
    how to correctly combine two prediction intervals, and no method for
    that is defined in this round. Only point-forecast accuracy (MAPE) is
    evaluated.

NOTE: the 15 rolling origins overlap (each forecasts 12 months ahead, one
month apart), so they are not independent observations. MAPE-by-horizon
and DM results below are therefore descriptive, the same caveat already
attached to ml/rolling_evaluation.py, ml/conformal_calibration.py and
ml/exog_experiments.py, not a formal statistical guarantee.

This script is written to be run with: py -3.13 ml/ensemble_experiment.py
(after ml/rolling_evaluation.py and ml/sarima_test.py have already
produced the stored result files it reads). It writes two NEW files only
(ml/results/ensemble_experiment.json,
ml/results/ensemble_rolling_predictions.csv) and never modifies any
existing file in ml/results/, nor ml/eval_common.py.
"""

import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from eval_common import (
    PROPHET_DEFAULT_PARAMS,
    RANDOM_SEED,
    TEST_MONTHS,
    TRAIN_MONTHS,
    ensure_results_dir,
    evaluate,
    fit_prophet_and_predict,
    load_consumption_df,
)
from significance_testing import dm_test

ROLLING_HORIZON = 12
DM_HORIZONS = (1, 6, 12)
SUMMARY_TOLERANCE_PP = 0.001  # percentage points
TEST_MAPE_TOLERANCE_PP = 0.001  # percentage points
ACTUAL_VALUE_TOLERANCE_M3 = 1.0  # m3 -- negligible at this series' multi-million-m3 scale

RESULTS_DIR = os.path.join(os.path.dirname(__file__), 'results')
ROLLING_PREDICTIONS_PATH = os.path.join(RESULTS_DIR, 'rolling_evaluation_predictions.csv')
ROLLING_SUMMARY_PATH = os.path.join(RESULTS_DIR, 'rolling_evaluation_summary.json')
SARIMA_TEST_PREDICTIONS_PATH = os.path.join(RESULTS_DIR, 'sarima_test_predictions.csv')
SARIMA_TEST_COMPARISON_PATH = os.path.join(RESULTS_DIR, 'sarima_test_comparison.json')

PROPHET_LABEL = 'Prophet (defaults)'
ENSEMBLE_LABEL = 'Ensemble (50/50)'
WEIGHT_PROPHET = 0.5
WEIGHT_SARIMA = 0.5


def load_rolling_summary():
    if not os.path.exists(ROLLING_SUMMARY_PATH):
        raise SystemExit(f"ERROR: {ROLLING_SUMMARY_PATH} not found. Run ml/rolling_evaluation.py first.")
    with open(ROLLING_SUMMARY_PATH) as f:
        return json.load(f)


def load_rolling_predictions():
    if not os.path.exists(ROLLING_PREDICTIONS_PATH):
        raise SystemExit(f"ERROR: {ROLLING_PREDICTIONS_PATH} not found. Run ml/rolling_evaluation.py first.")
    return pd.read_csv(ROLLING_PREDICTIONS_PATH)


def build_rolling_ensemble(stored, sarima_label):
    """Aligns the stored 'Prophet (defaults)' and SARIMA rolling rows by
    (origin, horizon), asserts they share the same 15 origins x 12
    horizons, the same target_month and the same actual per pair, and
    returns one DataFrame with columns: origin, horizon, target_month,
    actual, prophet_yhat, sarima_yhat, ensemble_yhat. Every row downstream
    (MAPE-by-horizon, DM alignment) is sliced from this single validated
    frame -- never re-merged -- so alignment can't drift later."""
    prophet_rows = stored[stored['model'] == PROPHET_LABEL][
        ['origin', 'horizon', 'target_month', 'actual', 'yhat']
    ].rename(columns={'target_month': 'target_month_p', 'actual': 'actual_p', 'yhat': 'prophet_yhat'})

    sarima_rows = stored[stored['model'] == sarima_label][
        ['origin', 'horizon', 'target_month', 'actual', 'yhat']
    ].rename(columns={'target_month': 'target_month_s', 'actual': 'actual_s', 'yhat': 'sarima_yhat'})

    assert len(prophet_rows) == 15 * ROLLING_HORIZON, (
        f"Expected {15 * ROLLING_HORIZON} stored '{PROPHET_LABEL}' rolling rows, got {len(prophet_rows)}."
    )
    assert len(sarima_rows) == 15 * ROLLING_HORIZON, (
        f"Expected {15 * ROLLING_HORIZON} stored {sarima_label!r} rolling rows, got {len(sarima_rows)}."
    )

    merged = prophet_rows.merge(sarima_rows, on=['origin', 'horizon'], how='inner')
    if len(merged) != len(prophet_rows) or len(merged) != len(sarima_rows):
        raise ValueError(
            f"Origin/horizon alignment mismatch between {PROPHET_LABEL!r} and {sarima_label!r}: "
            f"{len(prophet_rows)} Prophet rows, {len(sarima_rows)} SARIMA rows, {len(merged)} merged."
        )

    mismatched_targets = merged[merged['target_month_p'] != merged['target_month_s']]
    if len(mismatched_targets) > 0:
        raise ValueError(
            f"target_month mismatch between {PROPHET_LABEL!r} and {sarima_label!r} at "
            "(origin, horizon) pairs: "
            f"{list(zip(mismatched_targets['origin'], mismatched_targets['horizon']))}"
        )
    mismatched_actuals = merged[
        (merged['actual_p'] - merged['actual_s']).abs() > ACTUAL_VALUE_TOLERANCE_M3
    ]
    if len(mismatched_actuals) > 0:
        raise ValueError(
            f"actual mismatch between {PROPHET_LABEL!r} and {sarima_label!r} at "
            "(origin, horizon) pairs: "
            f"{list(zip(mismatched_actuals['origin'], mismatched_actuals['horizon']))}"
        )

    merged['ensemble_yhat'] = WEIGHT_PROPHET * merged['prophet_yhat'] + WEIGHT_SARIMA * merged['sarima_yhat']
    merged = merged.rename(columns={'target_month_p': 'target_month', 'actual_p': 'actual'})
    result = merged[
        ['origin', 'horizon', 'target_month', 'actual', 'prophet_yhat', 'sarima_yhat', 'ensemble_yhat']
    ].sort_values(['origin', 'horizon']).reset_index(drop=True)

    distinct_origins = result['origin'].nunique()
    assert distinct_origins == 15, f"Expected 15 distinct origins, got {distinct_origins}."
    assert len(result) == 15 * ROLLING_HORIZON, (
        f"Expected {15 * ROLLING_HORIZON} aligned rolling rows, got {len(result)}."
    )
    return result


def mape_by_horizon(df, yhat_col):
    """Per-horizon mean absolute percentage error and the average across
    h1..h12, computed directly from `df`'s own actual/yhat_col values."""
    work = df.copy()
    work['abs_pct_error'] = np.abs((work['actual'] - work[yhat_col]) / work['actual']) * 100

    by_horizon = {}
    for h, group in work.groupby('horizon'):
        by_horizon[int(h)] = float(group['abs_pct_error'].mean())

    average = float(np.mean(list(by_horizon.values())))
    return by_horizon, average


def assert_matches_stored_summary(label, by_horizon, stored_mape_by_horizon):
    mismatches = []
    for h, value in by_horizon.items():
        stored_value = stored_mape_by_horizon[str(h)]
        diff_pp = abs(value - stored_value)
        if diff_pp > SUMMARY_TOLERANCE_PP:
            mismatches.append((h, value, stored_value, diff_pp))
    if mismatches:
        lines = [
            f"  h{h}: recomputed={v:.6f}%, stored={sv:.6f}%, diff={d:.6f}pp"
            for h, v, sv, d in mismatches
        ]
        raise SystemExit(
            f"ERROR: {label}'s mean MAPE-by-horizon, recomputed from "
            f"{ROLLING_PREDICTIONS_PATH}, does not match "
            f"{ROLLING_SUMMARY_PATH}'s stored mape_by_horizon within "
            f"{SUMMARY_TOLERANCE_PP} percentage points:\n" + "\n".join(lines) +
            "\nStopping -- the stored rolling results cannot be trusted without this check passing."
        )


def run_prophet_test_refit(df):
    """Refits Prophet (defaults) EXACTLY ONCE on the 102 training months
    and forecasts the 26 test months. Returns (yhat, test_dates,
    test_actual)."""
    assert len(df) >= TRAIN_MONTHS + TEST_MONTHS, (
        f"Expected at least {TRAIN_MONTHS + TEST_MONTHS} months of consumption data, got {len(df)}."
    )
    train_df = df.iloc[:TRAIN_MONTHS][['ds', 'y']].reset_index(drop=True)
    test_df = df.iloc[TRAIN_MONTHS:TRAIN_MONTHS + TEST_MONTHS][['ds', 'y']].reset_index(drop=True)
    assert len(test_df) == TEST_MONTHS, f"Expected {TEST_MONTHS} test months, got {len(test_df)}."

    forecast = fit_prophet_and_predict(train_df, PROPHET_DEFAULT_PARAMS, TEST_MONTHS)
    return forecast['yhat'].values, test_df['ds'].values, test_df['y'].values


def run_test_consistency_check(refit_yhat, refit_dates, refit_actual):
    """Checks the Prophet refit's MAPE against sarima_test_comparison.json's
    stored Prophet (defaults) MAPE, and its dates/actuals against
    sarima_test_predictions.csv's dates/actuals. Stops with a clear error
    on any mismatch."""
    if not os.path.exists(SARIMA_TEST_COMPARISON_PATH):
        raise SystemExit(f"ERROR: {SARIMA_TEST_COMPARISON_PATH} not found. Run ml/sarima_test.py first.")
    with open(SARIMA_TEST_COMPARISON_PATH) as f:
        comparison = json.load(f)
    stored_mape = comparison['metrics'][PROPHET_LABEL]['mape']

    refit_metrics = evaluate(refit_yhat, refit_actual)
    mape_diff_pp = abs(refit_metrics['mape'] - stored_mape)
    if mape_diff_pp > TEST_MAPE_TOLERANCE_PP:
        raise SystemExit(
            f"ERROR: Prophet (defaults) refit on the 26-month test set has MAPE="
            f"{refit_metrics['mape']:.6f}%, but {SARIMA_TEST_COMPARISON_PATH} stores "
            f"{stored_mape:.6f}% -- difference {mape_diff_pp:.6f}pp exceeds the "
            f"{TEST_MAPE_TOLERANCE_PP}pp tolerance.\nStopping -- the refit cannot be trusted "
            "without this check passing."
        )

    if not os.path.exists(SARIMA_TEST_PREDICTIONS_PATH):
        raise SystemExit(f"ERROR: {SARIMA_TEST_PREDICTIONS_PATH} not found. Run ml/sarima_test.py first.")
    sarima_predictions = pd.read_csv(SARIMA_TEST_PREDICTIONS_PATH)
    assert len(sarima_predictions) == TEST_MONTHS, (
        f"Expected {TEST_MONTHS} stored SARIMA test rows, got {len(sarima_predictions)}."
    )

    refit_date_strs = [pd.Timestamp(d).strftime('%Y-%m-%d') for d in refit_dates]
    stored_date_strs = sarima_predictions['date'].tolist()
    if refit_date_strs != stored_date_strs:
        raise SystemExit(
            f"ERROR: Prophet refit's test dates do not match {SARIMA_TEST_PREDICTIONS_PATH}'s "
            f"dates:\n  refit:  {refit_date_strs}\n  stored: {stored_date_strs}\nStopping."
        )

    mismatched_actuals = [
        (d, a1, a2) for d, a1, a2 in zip(refit_date_strs, refit_actual, sarima_predictions['actual'].values)
        if abs(a1 - a2) > ACTUAL_VALUE_TOLERANCE_M3
    ]
    if mismatched_actuals:
        raise SystemExit(
            f"ERROR: Prophet refit's test actual values do not match "
            f"{SARIMA_TEST_PREDICTIONS_PATH}'s actual values: {mismatched_actuals}\nStopping."
        )

    return {
        'stored_mape_pct': stored_mape,
        'refit_mape_pct': refit_metrics['mape'],
        'mape_diff_pp': mape_diff_pp,
        'tolerance_pp': TEST_MAPE_TOLERANCE_PP,
        'dates_match': True,
        'actuals_match': True,
        'passed': True,
    }


def aligned_rolling_errors(rolling_df, horizon, yhat_col_a, yhat_col_b):
    """Errors (actual - yhat) for two columns of the already-aligned
    rolling_df at the given horizon, ordered by origin. No second merge
    is performed -- both columns come from the same validated rows, so
    they are aligned by construction."""
    rows = rolling_df[rolling_df['horizon'] == horizon].sort_values('origin')
    e_a = (rows['actual'] - rows[yhat_col_a]).values
    e_b = (rows['actual'] - rows[yhat_col_b]).values
    return e_a, e_b


def print_dm_line(label, h, dm_stat, p_value):
    if isinstance(p_value, str):
        print(f"  vs {label} h={h}: not computable")
    else:
        sig = '*' if p_value < 0.05 else ''
        print(f"  vs {label} h={h}: DM={dm_stat:>7.3f}  p={p_value:.4f} {sig}")


def main():
    np.random.seed(RANDOM_SEED)

    print("=== E4: equal 50/50 ensemble of Prophet (defaults) and SARIMA ===")

    summary = load_rolling_summary()
    sarima_label = summary['sarima_label']
    stored_rolling = load_rolling_predictions()

    print(f"\nBuilding the rolling ensemble from stored forecasts "
          f"('{PROPHET_LABEL}' and {sarima_label!r}, no new fitting)...")
    rolling_df = build_rolling_ensemble(stored_rolling, sarima_label)
    print(f"  aligned {rolling_df['origin'].nunique()} origins x {ROLLING_HORIZON} horizons; "
          "target_month and actual confirmed identical between the two models at every pair.")

    prophet_by_h, prophet_avg = mape_by_horizon(rolling_df, 'prophet_yhat')
    sarima_by_h, sarima_avg = mape_by_horizon(rolling_df, 'sarima_yhat')
    ensemble_by_h, ensemble_avg = mape_by_horizon(rolling_df, 'ensemble_yhat')

    print("\nConsistency check: recomputed Prophet/SARIMA rolling MAPE-by-horizon vs. the stored summary...")
    assert_matches_stored_summary(PROPHET_LABEL, prophet_by_h, summary['mape_by_horizon'][PROPHET_LABEL])
    assert_matches_stored_summary(sarima_label, sarima_by_h, summary['mape_by_horizon'][sarima_label])
    print(f"  PASS -- both within {SUMMARY_TOLERANCE_PP}pp of the stored mape_by_horizon")

    print("\nRolling-origin mean MAPE by horizon:")
    for h in range(1, ROLLING_HORIZON + 1):
        print(
            f"  h{h:>2}: {PROPHET_LABEL}={prophet_by_h[h]:.3f}%  {sarima_label}={sarima_by_h[h]:.3f}%  "
            f"{ENSEMBLE_LABEL}={ensemble_by_h[h]:.3f}%"
        )
    print(f"  avg : {PROPHET_LABEL}={prophet_avg:.3f}%  {sarima_label}={sarima_avg:.3f}%  "
          f"{ENSEMBLE_LABEL}={ensemble_avg:.3f}%")

    print(f"\nRefitting {PROPHET_LABEL} once for the 26-month test set...")
    df = load_consumption_df()
    refit_yhat, refit_dates, refit_actual = run_prophet_test_refit(df)
    consistency_result = run_test_consistency_check(refit_yhat, refit_dates, refit_actual)
    print(
        f"  PASS -- refit MAPE={consistency_result['refit_mape_pct']:.6f}% vs stored "
        f"{consistency_result['stored_mape_pct']:.6f}% (diff={consistency_result['mape_diff_pp']:.6f}pp, "
        f"tolerance {consistency_result['tolerance_pp']}pp); dates and actuals confirmed identical "
        f"to {SARIMA_TEST_PREDICTIONS_PATH}."
    )

    sarima_predictions = pd.read_csv(SARIMA_TEST_PREDICTIONS_PATH)
    sarima_test_yhat = sarima_predictions['yhat'].values
    ensemble_test_yhat = WEIGHT_PROPHET * refit_yhat + WEIGHT_SARIMA * sarima_test_yhat

    prophet_test_metrics = evaluate(refit_yhat, refit_actual)
    sarima_test_metrics = evaluate(sarima_test_yhat, refit_actual)
    ensemble_test_metrics = evaluate(ensemble_test_yhat, refit_actual)

    print("\n26-month test-set evaluation:")
    print(f"  {PROPHET_LABEL:<32} MAE={prophet_test_metrics['mae']:>13,.1f}  "
          f"RMSE={prophet_test_metrics['rmse']:>13,.1f}  MAPE={prophet_test_metrics['mape']:.3f}%")
    print(f"  {sarima_label:<32} MAE={sarima_test_metrics['mae']:>13,.1f}  "
          f"RMSE={sarima_test_metrics['rmse']:>13,.1f}  MAPE={sarima_test_metrics['mape']:.3f}%")
    print(f"  {ENSEMBLE_LABEL:<32} MAE={ensemble_test_metrics['mae']:>13,.1f}  "
          f"RMSE={ensemble_test_metrics['rmse']:>13,.1f}  MAPE={ensemble_test_metrics['mape']:.3f}%")

    print(f"\nSignificance (Diebold-Mariano, {ENSEMBLE_LABEL} vs {PROPHET_LABEL} and vs {sarima_label}), "
          "on aligned rolling errors:")
    dm_results = {'vs_prophet': {}, 'vs_sarima': {}}
    for h in DM_HORIZONS:
        e_ensemble, e_prophet = aligned_rolling_errors(rolling_df, h, 'ensemble_yhat', 'prophet_yhat')
        dm_stat, p_value = dm_test(e_ensemble, e_prophet, h)
        dm_results['vs_prophet'][h] = {'n': len(e_ensemble), 'dm_statistic': dm_stat, 'p_value': p_value}
        print_dm_line(PROPHET_LABEL, h, dm_stat, p_value)

        e_ensemble2, e_sarima = aligned_rolling_errors(rolling_df, h, 'ensemble_yhat', 'sarima_yhat')
        dm_stat_s, p_value_s = dm_test(e_ensemble2, e_sarima, h)
        dm_results['vs_sarima'][h] = {'n': len(e_ensemble2), 'dm_statistic': dm_stat_s, 'p_value': p_value_s}
        print_dm_line(sarima_label, h, dm_stat_s, p_value_s)

    print("\n=== Selection rule ===")
    print(f"{ENSEMBLE_LABEL} WINS only if it beats {PROPHET_LABEL} on BOTH the 26-month test MAPE "
          "AND the h12 rolling mean MAPE.")
    baseline_test_mape = prophet_test_metrics['mape']  # the refit, consistency-checked value
    baseline_h12_mape = prophet_by_h[12]
    ensemble_test_mape = ensemble_test_metrics['mape']
    ensemble_h12_mape = ensemble_by_h[12]
    test_diff = baseline_test_mape - ensemble_test_mape    # positive = ensemble better
    h12_diff = baseline_h12_mape - ensemble_h12_mape        # positive = ensemble better
    wins = (ensemble_test_mape < baseline_test_mape) and (ensemble_h12_mape < baseline_h12_mape)
    verdict = 'WINS' if wins else 'DOES NOT WIN'
    print(
        f"  {ENSEMBLE_LABEL}: {verdict}  "
        f"(test MAPE {ensemble_test_mape:.3f}% vs baseline {baseline_test_mape:.3f}%, "
        f"diff={test_diff:+.3f}pp; h12 rolling MAPE {ensemble_h12_mape:.3f}% vs baseline "
        f"{baseline_h12_mape:.3f}%, diff={h12_diff:+.3f}pp)"
    )

    # --- Write output files (new files only). ---
    results_dir = ensure_results_dir()

    out_rolling = rolling_df[
        ['origin', 'horizon', 'target_month', 'actual', 'prophet_yhat', 'sarima_yhat', 'ensemble_yhat']
    ]
    out_rolling.to_csv(os.path.join(results_dir, 'ensemble_rolling_predictions.csv'), index=False)

    run_timestamp = datetime.now(timezone.utc).isoformat()
    payload = {
        'method': (
            f"Equal 50/50 average of {PROPHET_LABEL} and {sarima_label} "
            f"({WEIGHT_PROPHET}/{WEIGHT_SARIMA}, no weight tuning). Point forecasts only -- no "
            "ensemble prediction interval is produced. The rolling ensemble is built entirely "
            "from already-stored forecasts (no new fitting); Prophet (defaults) is refit "
            "exactly once for the 26-month test set, with a reproduction check against the "
            "stored MAPE before trusting it."
        ),
        'weights': {'prophet': WEIGHT_PROPHET, 'sarima': WEIGHT_SARIMA},
        'sarima_label': sarima_label,
        'rolling': {
            'mape_by_horizon': {
                PROPHET_LABEL: {str(h): v for h, v in prophet_by_h.items()},
                sarima_label: {str(h): v for h, v in sarima_by_h.items()},
                ENSEMBLE_LABEL: {str(h): v for h, v in ensemble_by_h.items()},
            },
            'mape_average': {
                PROPHET_LABEL: prophet_avg,
                sarima_label: sarima_avg,
                ENSEMBLE_LABEL: ensemble_avg,
            },
            'stored_summary_consistency_check': {
                'tolerance_pp': SUMMARY_TOLERANCE_PP,
                'passed': True,
            },
        },
        'test_evaluation': {
            'prophet_refit_consistency_check': consistency_result,
            'metrics': {
                PROPHET_LABEL: prophet_test_metrics,
                sarima_label: sarima_test_metrics,
                ENSEMBLE_LABEL: ensemble_test_metrics,
            },
        },
        'dm_results': {
            'vs_prophet': {str(h): v for h, v in dm_results['vs_prophet'].items()},
            'vs_sarima': {str(h): v for h, v in dm_results['vs_sarima'].items()},
        },
        'selection_rule': (
            f"{ENSEMBLE_LABEL} WINS only if it beats {PROPHET_LABEL} on BOTH the 26-month test "
            "MAPE AND the h12 rolling mean MAPE simultaneously."
        ),
        'selection_outcome': {
            'wins': bool(wins),
            'test_mape_pct': ensemble_test_mape,
            'baseline_test_mape_pct': baseline_test_mape,
            'test_mape_diff_pp': test_diff,
            'h12_rolling_mape_pct': ensemble_h12_mape,
            'baseline_h12_rolling_mape_pct': baseline_h12_mape,
            'h12_rolling_mape_diff_pp': h12_diff,
        },
        'overlapping_origins_caveat': (
            "The 15 rolling origins overlap (each forecasts 12 months ahead, one month apart), "
            "so they are not independent observations; MAPE-by-horizon and DM results above "
            "are descriptive, not a formal statistical guarantee."
        ),
        'no_ensemble_interval_note': (
            "This experiment produces point forecasts only. Averaging two point forecasts says "
            "nothing about how to correctly combine two prediction intervals, and no method for "
            "that is defined in this round -- no ensemble lower/upper bound is reported anywhere."
        ),
        'run_timestamp': run_timestamp,
    }
    with open(os.path.join(results_dir, 'ensemble_experiment.json'), 'w') as f:
        json.dump(payload, f, indent=2)

    print(f"\nWrote {os.path.join(results_dir, 'ensemble_rolling_predictions.csv')}")
    print(f"Wrote {os.path.join(results_dir, 'ensemble_experiment.json')}")


if __name__ == '__main__':
    main()
