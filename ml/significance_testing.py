"""
Diebold-Mariano significance tests (squared-error loss, Harvey-Leybourne-
Newbold small-sample correction) on the forecast errors produced by
ml/rolling_evaluation.py, at horizons 1, 6 and 12.

Pairs tested: Prophet (defaults) vs SARIMA (chosen); Prophet (defaults) vs
seasonal-naive; SARIMA (chosen) vs seasonal-naive; Prophet (defaults) vs
Prophet (CV-tuned).

--- Diebold-Mariano test (Diebold & Mariano, 1995) ---
For two competing forecasts of the same series, with errors e1_t, e2_t at
each of n time points (here: the 15 rolling-evaluation origins, at a FIXED
horizon h), define the loss differential:
    d_t = L(e1_t) - L(e2_t),   L(e) = e^2   (squared-error loss, as specified)
Under H0: E[d_t] = 0 (equal predictive accuracy), the DM statistic is
    DM = mean(d) / sqrt( V_hat(mean(d)) )
where V_hat is a long-run variance estimate of d_t allowing for the MA(h-1)
autocorrelation structure h-step-ahead forecast errors have:
    V_hat = gamma_0 + 2 * sum_{k=1}^{h-1} gamma_k
    gamma_k = (1/n) * sum_{t=k+1}^{n} (d_t - mean(d)) * (d_{t-k} - mean(d))
DM is asymptotically N(0, 1), but with n as small as 15 that is a poor
approximation, so the Harvey, Leybourne & Newbold (1997) correction is
applied:
    HLN = sqrt( (n + 1 - 2h + h(h-1)/n) / n )
    DM_HLN = DM * HLN
and DM_HLN is compared against a Student's t distribution with (n - 1)
degrees of freedom instead of the standard normal.

Run with: python ml/significance_testing.py (after ml/rolling_evaluation.py)
Writes:
  ml/results/significance_testing_results.json
  ml/results/significance_testing_results.csv
"""

import json
import os

import numpy as np
import pandas as pd
from scipy import stats

from eval_common import ensure_results_dir
from run_logger import save_run

PREDICTIONS_PATH = os.path.join(os.path.dirname(__file__), 'results', 'rolling_evaluation_predictions.csv')
SUMMARY_PATH = os.path.join(os.path.dirname(__file__), 'results', 'rolling_evaluation_summary.json')
HORIZONS = (1, 6, 12)
N_ORIGINS = 15
H12_CAVEAT = (
    f"With n = {N_ORIGINS} origins, the h = 12 test uses 11 autocovariance lags; "
    "treat h = 12 results as indicative only."
)


def load_rolling_predictions():
    if not os.path.exists(PREDICTIONS_PATH) or not os.path.exists(SUMMARY_PATH):
        raise SystemExit(
            f"ERROR: {PREDICTIONS_PATH} / {SUMMARY_PATH} not found. Run ml/rolling_evaluation.py first."
        )
    df = pd.read_csv(PREDICTIONS_PATH)
    with open(SUMMARY_PATH) as f:
        summary = json.load(f)
    return df, summary['sarima_label']


def dm_test(e1, e2, h):
    """Diebold-Mariano test with the Harvey-Leybourne-Newbold small-sample
    correction, squared-error loss. e1, e2: aligned arrays of forecast
    errors (actual - yhat) for the SAME target months, at horizon h.
    Returns (dm_statistic, p_value); ('not computable', 'not computable')
    if the long-run variance estimate is non-positive (degenerate/too-short
    series) — not NaN, so it can't be silently treated as a numeric 0 or
    sorted/averaged by anything reading the saved results."""
    e1 = np.asarray(e1, dtype=float)
    e2 = np.asarray(e2, dtype=float)
    n = len(e1)
    if n != len(e2):
        raise ValueError("e1 and e2 must be the same length (aligned by origin)")

    d = e1 ** 2 - e2 ** 2
    d_mean = d.mean()

    # Long-run variance: gamma_0 + 2 * sum_{k=1}^{h-1} gamma_k, where
    # gamma_k = (1/n) * sum_{t=k+1}^{n} (d_t - mean)(d_{t-k} - mean) — the
    # divisor is n (the full sample size), not n-k, even though only n-k
    # terms are summed.
    gamma_0 = np.sum((d - d_mean) ** 2) / n
    var_d = gamma_0
    for k in range(1, h):
        gamma_k = np.sum((d[k:] - d_mean) * (d[:-k] - d_mean)) / n
        var_d += 2 * gamma_k

    if var_d <= 0:
        return 'not computable', 'not computable'

    dm_stat = d_mean / np.sqrt(var_d / n)

    # Harvey, Leybourne & Newbold (1997) small-sample correction.
    hln_factor = np.sqrt((n + 1 - 2 * h + h * (h - 1) / n) / n)
    dm_corrected = dm_stat * hln_factor

    p_value = 2 * (1 - stats.t.cdf(np.abs(dm_corrected), df=n - 1))
    return float(dm_corrected), float(p_value)


def errors_for(df, model_name, horizon):
    rows = df[(df['model'] == model_name) & (df['horizon'] == horizon)].sort_values('origin')
    return rows['origin'].values, (rows['actual'] - rows['yhat']).values


def aligned_errors(df, model_a, model_b, horizon):
    origins_a, errors_a = errors_for(df, model_a, horizon)
    origins_b, errors_b = errors_for(df, model_b, horizon)
    if list(origins_a) != list(origins_b):
        raise ValueError(f"Origins for {model_a!r} and {model_b!r} at horizon {horizon} don't match")
    return errors_a, errors_b


def main():
    predictions_df, sarima_label = load_rolling_predictions()

    pairs = [
        ('Prophet (defaults)', sarima_label),
        ('Prophet (defaults)', 'Seasonal-naive'),
        (sarima_label, 'Seasonal-naive'),
        ('Prophet (defaults)', 'Prophet (CV-tuned)'),
    ]

    results = []
    print("Diebold-Mariano tests (squared-error loss, HLN correction), n=15 origins per horizon\n")
    for model_a, model_b in pairs:
        print(f"{model_a} vs {model_b}:")
        for h in HORIZONS:
            e1, e2 = aligned_errors(predictions_df, model_a, model_b, h)
            dm_stat, p_value = dm_test(e1, e2, h)
            n = len(e1)
            results.append({
                'model_a': model_a,
                'model_b': model_b,
                'horizon': h,
                'n': n,
                'dm_statistic': dm_stat,
                'p_value': p_value,
            })
            if isinstance(p_value, str):
                print(f"  h={h:<2} n={n:<2} DM=not computable  p=not computable")
            else:
                sig = '*' if p_value < 0.05 else ''
                print(f"  h={h:<2} n={n:<2} DM={dm_stat:>7.3f}  p={p_value:.4f} {sig}")
        print()

    print(f"NOTE: {H12_CAVEAT}\n")

    results_dir = ensure_results_dir()
    with open(os.path.join(results_dir, 'significance_testing_results.json'), 'w') as f:
        json.dump({'results': results, 'caveats': [H12_CAVEAT]}, f, indent=2)
    pd.DataFrame(results).to_csv(os.path.join(results_dir, 'significance_testing_results.csv'), index=False)

    print(f"Results saved to {results_dir}")
    print(f"(* = p < 0.05. This is a diagnostic threshold, not multiple-comparison-corrected; "
          f"{len(results)} tests were run.)")

    save_run(
        run_name='significance_testing',
        params={
            'pairs': [f"{a} vs {b}" for a, b in pairs],
            'horizons': list(HORIZONS),
            'loss': 'squared_error',
            'correction': 'Harvey-Leybourne-Newbold',
            'caveats': [H12_CAVEAT],
        },
        metrics={
            f"{r['model_a']} vs {r['model_b']} (h={r['horizon']})": {
                'dm_statistic': r['dm_statistic'], 'p_value': r['p_value']
            }
            for r in results
        },
    )


if __name__ == '__main__':
    main()
