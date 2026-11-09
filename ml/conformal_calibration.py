"""
E1 (Experiment Protocol 2): split-conformal calibration of Prophet
(defaults)'s 80% prediction interval.

Method (fixed before this script is ever run — see
docs/experiment_protocol_2.md, "E1 method details"):

  - Calibration origins: every month-start from 2017-06-01 to 2021-06-01
    inclusive (49 origins). Each origin's 12-month forecast target window
    ends by 2022-06-01 at the latest, so no calibration origin or target
    month overlaps the 15 rolling-origin test set (2022-06-01 .. 2023-08-01,
    whose own 12-month targets run through 2024-08-01) or the 26-month test
    period (2022-07-01 .. 2024-08-01). This is asserted in code, not just
    assumed.
  - Score per (origin, horizon h): the relative error
    r = actual / yhat - 1, from a Prophet (defaults) refit trained on all
    data up to and including that origin.
  - Per horizon h, 49 scores (one per calibration origin) give a
    finite-sample split-conformal interval: sort the scores, take
    q_lo = the k_lo-th smallest and q_hi = the k_hi-th smallest, with
    k_lo = floor((n+1) * alpha/2), k_hi = ceil((n+1) * (1 - alpha/2)),
    alpha = 0.20 for an 80% interval. With n=49 this is k_lo=5, k_hi=45.
  - Before trusting any stored test-set forecast, this script refits
    Prophet (defaults) once more at origin 2022-06-01 (training data only)
    and checks its 12 yhat values against the stored
    ml/results/rolling_evaluation_predictions.csv row for that same
    origin, within 0.01% relative tolerance. This is a reproducibility
    guard, not part of the calibration itself.
  - The 15-test-origin evaluation uses the STORED 'Prophet (defaults)'
    yhat/actual values from rolling_evaluation_predictions.csv directly —
    Prophet is not refit a second time for this step. The conformal
    interval is lower = yhat * (1 + q_lo[h]), upper = yhat * (1 + q_hi[h]),
    using that row's own horizon's q_lo/q_hi.
  - Interval width is always reported as a percentage of yhat,
    (upper - lower) / yhat * 100, so intervals of very different scale
    (different horizons, different models) are comparable.

NOTE: the 15 test origins used for evaluation are not independent — each
origin's 12-month forecast window overlaps its neighbours' (origins are
one month apart but forecast 12 months ahead). Coverage and width figures
below are therefore descriptive, the same caveat already attached to
ml/rolling_evaluation.py's coverage figures, not a formal confidence-
interval guarantee.

This script is written to be run with: py -3.13 ml/conformal_calibration.py
(after ml/rolling_evaluation.py has already produced
ml/results/rolling_evaluation_predictions.csv). It writes two NEW files
only (ml/results/conformal_calibration.json,
ml/results/conformal_predictions.csv) and never modifies any existing file
in ml/results/.
"""

import json
import math
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from eval_common import (
    PROPHET_DEFAULT_PARAMS,
    RANDOM_SEED,
    ensure_results_dir,
    fit_prophet_and_predict,
    load_consumption_df,
)

HORIZON = 12
ALPHA = 0.20  # 80% interval
CALIBRATION_START = '2017-06-01'
CALIBRATION_END = '2021-06-01'
CALIBRATION_BOUNDARY = pd.Timestamp('2022-06-01')  # last training month (Protocol 1)
CONSISTENCY_CHECK_ORIGIN = '2022-06-01'
CONSISTENCY_TOLERANCE_PCT = 0.01  # relative tolerance, percent

RESULTS_DIR = os.path.join(os.path.dirname(__file__), 'results')
ROLLING_PREDICTIONS_PATH = os.path.join(RESULTS_DIR, 'rolling_evaluation_predictions.csv')

KNOWN_NON_SARIMA_MODELS = {
    'Prophet (defaults)',
    'Prophet (CV-tuned)',
    'Seasonal-naive',
    'Last-year x growth',
}


def find_origin_index(df, origin_date):
    matches = df.index[df['ds'] == pd.Timestamp(origin_date)]
    if len(matches) == 0:
        raise SystemExit(f"ERROR: origin {origin_date} not found in the consumption series.")
    return int(matches[0])


def calibration_origins():
    origins = pd.date_range(CALIBRATION_START, CALIBRATION_END, freq='MS')
    assert len(origins) == 49, (
        f"Expected 49 calibration origins ({CALIBRATION_START}..{CALIBRATION_END}), got {len(origins)}."
    )
    return origins


def compute_calibration_scores(df):
    """For each calibration origin, refit Prophet (defaults) on all data up
    to and including that origin and forecast 12 months ahead. Returns
    scores_by_horizon: {h: [r_1, ..., r_49]} where r = actual/yhat - 1.
    """
    scores_by_horizon = {h: [] for h in range(1, HORIZON + 1)}

    for origin_date in calibration_origins():
        origin_index = find_origin_index(df, origin_date)

        targets = df.iloc[origin_index + 1: origin_index + 1 + HORIZON]
        if len(targets) < HORIZON:
            raise SystemExit(
                f"ERROR: origin {origin_date.date()} does not have {HORIZON} months of "
                f"target data available ({len(targets)} found)."
            )
        target_dates = targets['ds'].reset_index(drop=True)
        target_actuals = targets['y'].reset_index(drop=True)

        # Critical data-leakage guard: every calibration target month must
        # fall inside the training period, strictly before the 15
        # rolling-origin test set and the 26-month held-out test period.
        last_target = pd.Timestamp(target_dates.iloc[-1])
        assert last_target <= CALIBRATION_BOUNDARY, (
            f"Calibration origin {origin_date.date()}'s last target month "
            f"({last_target.date()}) is after the training-period boundary "
            f"({CALIBRATION_BOUNDARY.date()}) -- this would leak calibration "
            f"data into the test/rolling-origin period."
        )

        train_df = df.iloc[:origin_index + 1][['ds', 'y']].reset_index(drop=True)
        forecast = fit_prophet_and_predict(train_df, PROPHET_DEFAULT_PARAMS, HORIZON)
        yhat = forecast['yhat'].values

        for h in range(HORIZON):
            actual = float(target_actuals.iloc[h])
            r = actual / yhat[h] - 1.0
            scores_by_horizon[h + 1].append(r)

    for h, scores in scores_by_horizon.items():
        assert len(scores) == 49, f"Expected 49 calibration scores at horizon {h}, got {len(scores)}."

    return scores_by_horizon


def conformal_quantiles(scores_by_horizon, alpha):
    """Per horizon, finite-sample split-conformal q_lo/q_hi from the sorted
    scores. Returns (q_lo_by_horizon, q_hi_by_horizon, k_lo, k_hi, n)."""
    n = len(next(iter(scores_by_horizon.values())))
    k_lo = math.floor((n + 1) * alpha / 2)
    k_hi = math.ceil((n + 1) * (1 - alpha / 2))

    assert 1 <= k_lo, f"k_lo={k_lo} is out of range for n={n}."
    assert k_hi <= n, f"k_hi={k_hi} is out of range for n={n} (max index {n})."
    # Sanity check for this experiment's exact n=49, alpha=0.20.
    if n == 49 and abs(alpha - 0.20) < 1e-12:
        assert k_lo == 5, f"Expected k_lo=5 for n=49, alpha=0.20, got {k_lo}."
        assert k_hi == 45, f"Expected k_hi=45 for n=49, alpha=0.20, got {k_hi}."

    q_lo_by_horizon = {}
    q_hi_by_horizon = {}
    for h, scores in scores_by_horizon.items():
        sorted_scores = sorted(scores)
        q_lo_by_horizon[h] = sorted_scores[k_lo - 1]
        q_hi_by_horizon[h] = sorted_scores[k_hi - 1]

    return q_lo_by_horizon, q_hi_by_horizon, k_lo, k_hi, n


def run_consistency_check(df):
    """Refits Prophet (defaults) at CONSISTENCY_CHECK_ORIGIN using training
    data only, and checks the 12 yhat values against the stored
    'Prophet (defaults)' rows for that origin in
    rolling_evaluation_predictions.csv, within CONSISTENCY_TOLERANCE_PCT
    relative tolerance. Stops with a clear error on any mismatch.
    """
    if not os.path.exists(ROLLING_PREDICTIONS_PATH):
        raise SystemExit(
            f"ERROR: {ROLLING_PREDICTIONS_PATH} not found. "
            "Run ml/rolling_evaluation.py first."
        )

    stored = pd.read_csv(ROLLING_PREDICTIONS_PATH)
    stored_rows = stored[
        (stored['origin'] == CONSISTENCY_CHECK_ORIGIN) & (stored['model'] == 'Prophet (defaults)')
    ].sort_values('horizon')

    if len(stored_rows) != HORIZON:
        raise SystemExit(
            f"ERROR: expected {HORIZON} stored 'Prophet (defaults)' rows for origin "
            f"{CONSISTENCY_CHECK_ORIGIN}, found {len(stored_rows)}."
        )

    origin_index = find_origin_index(df, CONSISTENCY_CHECK_ORIGIN)
    train_df = df.iloc[:origin_index + 1][['ds', 'y']].reset_index(drop=True)
    forecast = fit_prophet_and_predict(train_df, PROPHET_DEFAULT_PARAMS, HORIZON)
    refit_yhat = forecast['yhat'].values
    stored_yhat = stored_rows['yhat'].values

    mismatches = []
    for h in range(HORIZON):
        rel_diff_pct = abs(refit_yhat[h] - stored_yhat[h]) / abs(stored_yhat[h]) * 100
        if rel_diff_pct > CONSISTENCY_TOLERANCE_PCT:
            mismatches.append((h + 1, stored_yhat[h], refit_yhat[h], rel_diff_pct))

    if mismatches:
        lines = [
            f"  horizon {h}: stored yhat={stored_yhat_val:.4f}, refit yhat={refit_yhat_val:.4f}, "
            f"relative diff={rel_diff_pct:.6f}%"
            for h, stored_yhat_val, refit_yhat_val, rel_diff_pct in mismatches
        ]
        raise SystemExit(
            f"ERROR: Prophet (defaults) refit at origin {CONSISTENCY_CHECK_ORIGIN} does not "
            f"match the stored rolling_evaluation_predictions.csv values within "
            f"{CONSISTENCY_TOLERANCE_PCT}% relative tolerance:\n" + "\n".join(lines) +
            "\nStopping -- the stored test forecasts cannot be trusted without this check "
            "passing. Do not proceed with the test-set evaluation below."
        )

    max_rel_diff_pct = float(
        np.max(np.abs(refit_yhat - stored_yhat) / np.abs(stored_yhat) * 100)
    )
    return {
        'origin': CONSISTENCY_CHECK_ORIGIN,
        'tolerance_pct': CONSISTENCY_TOLERANCE_PCT,
        'max_relative_diff_pct': max_rel_diff_pct,
        'passed': True,
    }


def resolve_sarima_label(stored):
    models = stored['model'].unique().tolist()
    sarima_candidates = [m for m in models if m not in KNOWN_NON_SARIMA_MODELS]
    if len(sarima_candidates) != 1:
        raise SystemExit(
            f"ERROR: expected exactly one SARIMA model label in "
            f"{ROLLING_PREDICTIONS_PATH}, found {sarima_candidates}."
        )
    return sarima_candidates[0]


def build_conformal_predictions(stored, q_lo_by_horizon, q_hi_by_horizon):
    """Builds the 15-test-origin x 12-horizon conformal interval rows from
    the stored 'Prophet (defaults)' yhat/actual values (no refitting)."""
    prophet_rows = stored[stored['model'] == 'Prophet (defaults)'].copy()
    test_origins = sorted(prophet_rows['origin'].unique().tolist())
    assert len(test_origins) == 15, f"Expected 15 test origins, found {len(test_origins)}."

    prophet_rows['q_lo'] = prophet_rows['horizon'].map(q_lo_by_horizon)
    prophet_rows['q_hi'] = prophet_rows['horizon'].map(q_hi_by_horizon)
    prophet_rows['lower'] = prophet_rows['yhat'] * (1 + prophet_rows['q_lo'])
    prophet_rows['upper'] = prophet_rows['yhat'] * (1 + prophet_rows['q_hi'])

    conformal_df = prophet_rows[
        ['origin', 'horizon', 'target_month', 'actual', 'yhat', 'lower', 'upper']
    ].sort_values(['origin', 'horizon']).reset_index(drop=True)

    assert len(conformal_df) == 15 * HORIZON, (
        f"Expected {15 * HORIZON} conformal prediction rows, got {len(conformal_df)}."
    )
    return conformal_df, test_origins


def coverage_metrics(rows, lower_col, upper_col):
    """Per-horizon two-sided coverage, at-or-below-upper coverage, and mean
    width-as-%-of-yhat, for the given rows (one model's worth)."""
    rows = rows.copy()
    lower = rows[lower_col]
    upper = rows[upper_col]
    rows['two_sided'] = (rows['actual'] >= lower) & (rows['actual'] <= upper)
    rows['at_or_below_upper'] = rows['actual'] <= upper
    rows['width_pct'] = (upper - lower) / rows['yhat'] * 100

    by_horizon = {}
    for h, group in rows.groupby('horizon'):
        by_horizon[int(h)] = {
            'two_sided_coverage_pct': float(group['two_sided'].mean() * 100),
            'at_or_below_upper_coverage_pct': float(group['at_or_below_upper'].mean() * 100),
            'mean_width_pct': float(group['width_pct'].mean()),
            'n': int(len(group)),
        }

    averaged = {
        'two_sided_coverage_pct': float(np.mean([v['two_sided_coverage_pct'] for v in by_horizon.values()])),
        'at_or_below_upper_coverage_pct': float(
            np.mean([v['at_or_below_upper_coverage_pct'] for v in by_horizon.values()])
        ),
        'mean_width_pct': float(np.mean([v['mean_width_pct'] for v in by_horizon.values()])),
    }
    return by_horizon, averaged


def print_report(label, by_horizon, averaged):
    print(f"\n--- {label} ---")
    for h in range(1, HORIZON + 1):
        m = by_horizon[h]
        print(
            f"  h{h:>2}: two-sided={m['two_sided_coverage_pct']:.1f}%  "
            f"at-or-below-upper={m['at_or_below_upper_coverage_pct']:.1f}%  "
            f"width={m['mean_width_pct']:.1f}% of yhat  (n={m['n']})"
        )
    print(
        f"  avg : two-sided={averaged['two_sided_coverage_pct']:.1f}%  "
        f"at-or-below-upper={averaged['at_or_below_upper_coverage_pct']:.1f}%  "
        f"width={averaged['mean_width_pct']:.1f}% of yhat"
    )


def main():
    np.random.seed(RANDOM_SEED)

    print("=== E1: Conformal calibration of Prophet (defaults)'s 80% interval ===")

    df = load_consumption_df()

    print(f"\nConsistency check: refitting Prophet (defaults) at origin {CONSISTENCY_CHECK_ORIGIN} "
          f"and comparing to the stored rolling-evaluation forecast...")
    consistency_result = run_consistency_check(df)
    print(
        f"  PASS -- max relative difference {consistency_result['max_relative_diff_pct']:.6f}% "
        f"(tolerance {CONSISTENCY_TOLERANCE_PCT}%)"
    )

    print(f"\nComputing calibration scores from 49 origins ({CALIBRATION_START} .. {CALIBRATION_END})...")
    scores_by_horizon = compute_calibration_scores(df)

    q_lo_by_horizon, q_hi_by_horizon, k_lo, k_hi, n = conformal_quantiles(scores_by_horizon, ALPHA)
    print(f"\nk_lo={k_lo}, k_hi={k_hi}, n={n} (per horizon)")
    print("q_lo / q_hi by horizon (%):")
    for h in range(1, HORIZON + 1):
        print(f"  h{h:>2}: q_lo={q_lo_by_horizon[h] * 100:+.2f}%  q_hi={q_hi_by_horizon[h] * 100:+.2f}%  n={len(scores_by_horizon[h])}")

    stored = pd.read_csv(ROLLING_PREDICTIONS_PATH)
    sarima_label = resolve_sarima_label(stored)

    conformal_df, test_origins = build_conformal_predictions(stored, q_lo_by_horizon, q_hi_by_horizon)

    prophet_rows = stored[stored['model'] == 'Prophet (defaults)'].sort_values(['origin', 'horizon']).reset_index(drop=True)
    sarima_rows = stored[stored['model'] == sarima_label].sort_values(['origin', 'horizon']).reset_index(drop=True)

    prophet_raw_by_h, prophet_raw_avg = coverage_metrics(prophet_rows, 'lower', 'upper')
    prophet_conformal_by_h, prophet_conformal_avg = coverage_metrics(conformal_df, 'lower', 'upper')
    sarima_by_h, sarima_avg = coverage_metrics(sarima_rows, 'lower', 'upper')

    print_report('Prophet (defaults) -- raw interval', prophet_raw_by_h, prophet_raw_avg)
    print_report('Prophet (defaults) -- conformal interval', prophet_conformal_by_h, prophet_conformal_avg)
    print_report(f'{sarima_label} -- stored interval', sarima_by_h, sarima_avg)

    # --- Success criteria ---
    baseline_two_sided_pct = 66.7
    nominal_pct = 80.0
    conformal_two_sided_avg = prophet_conformal_avg['two_sided_coverage_pct']
    criterion_a_pass = abs(conformal_two_sided_avg - nominal_pct) < abs(baseline_two_sided_pct - nominal_pct)

    conformal_h1_at_or_below_upper = prophet_conformal_by_h[1]['at_or_below_upper_coverage_pct']
    criterion_b_pass = conformal_h1_at_or_below_upper >= 90.0

    print("\n=== Success criteria ===")
    print(
        f"(a) conformal two-sided avg coverage closer to 80% than baseline 66.7%: "
        f"{'PASS' if criterion_a_pass else 'FAIL'} "
        f"(conformal avg={conformal_two_sided_avg:.1f}%, "
        f"|conformal-80|={abs(conformal_two_sided_avg - nominal_pct):.1f}, "
        f"|66.7-80|={abs(baseline_two_sided_pct - nominal_pct):.1f})"
    )
    print(
        f"(b) conformal at-or-below-upper coverage at h1 >= 90%: "
        f"{'PASS' if criterion_b_pass else 'FAIL'} (value={conformal_h1_at_or_below_upper:.1f}%)"
    )

    # --- Write output files (new files only). ---
    results_dir = ensure_results_dir()

    conformal_df.to_csv(os.path.join(results_dir, 'conformal_predictions.csv'), index=False)

    run_timestamp = datetime.now(timezone.utc).isoformat()
    payload = {
        'method': (
            "Split-conformal calibration of Prophet (defaults)'s 80% interval, using "
            "relative-error scores (actual/yhat - 1) from 49 calibration origins "
            f"({CALIBRATION_START} .. {CALIBRATION_END}, all inside the training period), "
            "and finite-sample per-horizon quantiles applied to the stored 15-test-origin "
            "rolling-evaluation forecasts (no refitting for the test evaluation itself)."
        ),
        'calibration': {
            'origins': [d.strftime('%Y-%m-%d') for d in calibration_origins()],
            'alpha': ALPHA,
            'k_lo': k_lo,
            'k_hi': k_hi,
            'n_per_horizon': {str(h): len(scores_by_horizon[h]) for h in range(1, HORIZON + 1)},
            'q_lo_by_horizon': {str(h): q_lo_by_horizon[h] for h in range(1, HORIZON + 1)},
            'q_hi_by_horizon': {str(h): q_hi_by_horizon[h] for h in range(1, HORIZON + 1)},
        },
        'consistency_check': consistency_result,
        'test_evaluation': {
            'test_origins': test_origins,
            'sarima_label': sarima_label,
            'metrics_by_horizon': {
                'prophet_raw': {str(h): v for h, v in prophet_raw_by_h.items()},
                'prophet_conformal': {str(h): v for h, v in prophet_conformal_by_h.items()},
                'sarima': {str(h): v for h, v in sarima_by_h.items()},
            },
            'metrics_average': {
                'prophet_raw': prophet_raw_avg,
                'prophet_conformal': prophet_conformal_avg,
                'sarima': sarima_avg,
            },
        },
        'success_criteria': {
            'a_two_sided_closer_to_80_than_66_7': {
                'pass': bool(criterion_a_pass),
                'conformal_avg_two_sided_coverage_pct': conformal_two_sided_avg,
                'baseline_avg_two_sided_coverage_pct': baseline_two_sided_pct,
                'nominal_pct': nominal_pct,
            },
            'b_h1_at_or_below_upper_at_least_90': {
                'pass': bool(criterion_b_pass),
                'conformal_h1_at_or_below_upper_coverage_pct': conformal_h1_at_or_below_upper,
            },
        },
        'coverage_caveat': (
            "The 15 test origins overlap (each forecasts 12 months ahead, one month apart), "
            "so they are not independent observations; coverage and width figures above are "
            "descriptive, not a formal confidence-interval guarantee."
        ),
        'run_timestamp': run_timestamp,
    }
    with open(os.path.join(results_dir, 'conformal_calibration.json'), 'w') as f:
        json.dump(payload, f, indent=2)

    print(f"\nWrote {os.path.join(results_dir, 'conformal_predictions.csv')}")
    print(f"Wrote {os.path.join(results_dir, 'conformal_calibration.json')}")


if __name__ == '__main__':
    main()
