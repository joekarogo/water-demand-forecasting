"""
E1 model selection: grid search over 144 SARIMA(p,d,q)(P,D,Q)12 candidates,
ranked by rolling-origin cross-validation RMSE on the 102 TRAINING months
only (the 26-month test set is never touched here). Ties are broken by AIC
from a fit on the full 102 months.

Evaluation protocol — fixed 26 October 2026 (01:58 EAT):
  p, q in {0, 1, 2}; d in {0, 1}; P, Q in {0, 1}; D in {0, 1}  (144 candidates)
  Rolling CV on the 102 training months: initial 28 months, step 6,
  horizon 6 -> 12 folds, cutoffs at months 28, 34, ..., 94.
  Settings that fail to fit/converge (in any CV fold, or in the final
  full-sample fit used for AIC) are excluded and listed.

Run with: python ml/sarima_select.py
Writes:
  ml/results/sarima_select_results.json  (ranked candidates + excluded list + chosen)
  ml/results/sarima_select_results.csv   (ranked candidates, tabular)
  ml/results/sarima_select_chosen.json   (just the chosen setting — read by
                                           ml/sarima_test.py, ml/rolling_evaluation.py
                                           and ml/error_analysis.py)
"""

import itertools
import json
import os
import time
import warnings

import numpy as np
import pandas as pd
from statsmodels.tools.sm_exceptions import ConvergenceWarning
from statsmodels.tsa.statespace.sarimax import SARIMAX

from eval_common import ensure_results_dir, load_consumption_df, SEASONAL_PERIOD, TRAIN_MONTHS
from run_logger import save_run

CV_INITIAL = 28
CV_STEP = 6
CV_HORIZON = 6
CV_CUTOFFS = list(range(CV_INITIAL, TRAIN_MONTHS - CV_HORIZON + 1, CV_STEP))
# Sanity-checked against the protocol: 28, 34, ..., 94 -> 12 folds.
assert CV_CUTOFFS == [28, 34, 40, 46, 52, 58, 64, 70, 76, 82, 88, 94], CV_CUTOFFS

P_RANGE = (0, 1, 2)
Q_RANGE = (0, 1, 2)
D_RANGE = (0, 1)
SEASONAL_P_RANGE = (0, 1)
SEASONAL_Q_RANGE = (0, 1)
SEASONAL_D_RANGE = (0, 1)


def candidate_grid():
    for p, d, q, seasonal_p, seasonal_d, seasonal_q in itertools.product(
        P_RANGE, D_RANGE, Q_RANGE, SEASONAL_P_RANGE, SEASONAL_D_RANGE, SEASONAL_Q_RANGE
    ):
        yield (p, d, q), (seasonal_p, seasonal_d, seasonal_q, SEASONAL_PERIOD)


def _fit_sarimax(y, order, seasonal_order):
    """Fits one SARIMAX model, raising on any exception OR
    ConvergenceWarning (both are treated as a failed/non-converged fit per
    the protocol). enforce_stationarity/enforce_invertibility are relaxed
    — standard practice for a blind grid search — so a candidate is only
    excluded for a genuine fit/convergence failure, not a borderline
    stationarity/invertibility check."""
    with warnings.catch_warnings():
        warnings.simplefilter('error', category=ConvergenceWarning)
        model = SARIMAX(
            y, order=order, seasonal_order=seasonal_order,
            enforce_stationarity=False, enforce_invertibility=False,
        )
        return model.fit(disp=False)


def rolling_cv_metrics(y, order, seasonal_order):
    """Mean RMSE/MAE/MAPE across the 12 rolling-CV folds (102 training
    months only). Raises on the first fold that fails to fit/converge —
    the caller excludes the whole candidate in that case."""
    rmses, maes, mapes = [], [], []
    for cutoff in CV_CUTOFFS:
        fold_train = y[:cutoff]
        fold_actual = y[cutoff:cutoff + CV_HORIZON]
        result = _fit_sarimax(fold_train, order, seasonal_order)
        fold_pred = np.asarray(result.get_forecast(steps=CV_HORIZON).predicted_mean)
        rmses.append(float(np.sqrt(np.mean((fold_actual - fold_pred) ** 2))))
        maes.append(float(np.mean(np.abs(fold_actual - fold_pred))))
        mapes.append(float(np.mean(np.abs((fold_actual - fold_pred) / fold_actual)) * 100))
    return float(np.mean(rmses)), float(np.mean(maes)), float(np.mean(mapes)), len(CV_CUTOFFS)


def main():
    df = load_consumption_df()
    train_y = df['y'].values[:TRAIN_MONTHS]
    assert len(train_y) == TRAIN_MONTHS, f"Expected {TRAIN_MONTHS} training months, got {len(train_y)}"

    print(f"Loaded {len(df)} months total; using the first {TRAIN_MONTHS} for rolling CV.")
    print(f"CV folds: initial={CV_INITIAL}, step={CV_STEP}, horizon={CV_HORIZON} -> cutoffs {CV_CUTOFFS}")

    candidates = list(candidate_grid())
    print(f"Evaluating {len(candidates)} SARIMA(p,d,q)(P,D,Q)12 candidates...")

    results = []
    excluded = []
    start = time.time()

    for i, (order, seasonal_order) in enumerate(candidates, 1):
        label = f"SARIMA{order}x{seasonal_order}"
        t0 = time.time()
        try:
            mean_rmse, mean_mae, mean_mape, n_folds = rolling_cv_metrics(train_y, order, seasonal_order)
        except Exception as err:
            excluded.append({
                'order': list(order),
                'seasonal_order': list(seasonal_order),
                'reason': f"{type(err).__name__}: {err}",
            })
            print(f"[{i}/{len(candidates)}] {label} -> EXCLUDED ({type(err).__name__})")
            continue

        try:
            full_fit = _fit_sarimax(train_y, order, seasonal_order)
            aic = float(full_fit.aic)
        except Exception as err:
            excluded.append({
                'order': list(order),
                'seasonal_order': list(seasonal_order),
                'reason': f"full-sample fit failed: {type(err).__name__}: {err}",
            })
            print(f"[{i}/{len(candidates)}] {label} -> EXCLUDED (full-sample fit failed)")
            continue

        results.append({
            'order': list(order),
            'seasonal_order': list(seasonal_order),
            'mean_rmse': mean_rmse,
            'mean_mae': mean_mae,
            'mean_mape': mean_mape,
            'aic': aic,
            'cv_folds': n_folds,
        })
        print(f"[{i}/{len(candidates)}] {label} -> mean RMSE {mean_rmse:,.2f}, "
              f"AIC {aic:,.2f} ({time.time() - t0:.1f}s)")

    elapsed = time.time() - start
    print(f"\nDone in {elapsed / 60:.1f} minutes. {len(results)} fitted, {len(excluded)} excluded.")

    # Rank by mean CV RMSE; ties broken by lower AIC (full-sample fit).
    results_sorted = sorted(results, key=lambda r: (r['mean_rmse'], r['aic']))

    if not results_sorted:
        raise SystemExit("ERROR: every candidate failed to fit/converge — nothing to select.")

    chosen = results_sorted[0]

    print("\n=== Top 10 candidates (ranked by mean CV RMSE, ties by AIC) ===")
    for rank, r in enumerate(results_sorted[:10], 1):
        print(f"{rank}. SARIMA{tuple(r['order'])}x{tuple(r['seasonal_order'])} "
              f"-> mean RMSE {r['mean_rmse']:,.2f} m3, AIC {r['aic']:,.2f}")

    print(f"\nChosen: SARIMA{tuple(chosen['order'])}x{tuple(chosen['seasonal_order'])} "
          f"(mean RMSE {chosen['mean_rmse']:,.2f} m3, AIC {chosen['aic']:,.2f})")

    if excluded:
        print(f"\n{len(excluded)} candidates excluded (failed to fit/converge):")
        for e in excluded:
            print(f"  SARIMA{tuple(e['order'])}x{tuple(e['seasonal_order'])}: {e['reason']}")

    results_dir = ensure_results_dir()

    with open(os.path.join(results_dir, 'sarima_select_results.json'), 'w') as f:
        json.dump({'candidates': results_sorted, 'excluded': excluded, 'chosen': chosen}, f, indent=2)

    pd.DataFrame(results_sorted).to_csv(
        os.path.join(results_dir, 'sarima_select_results.csv'), index=False
    )

    with open(os.path.join(results_dir, 'sarima_select_chosen.json'), 'w') as f:
        json.dump(chosen, f, indent=2)

    print(f"\nFull ranked table and chosen setting saved to {results_dir}")

    save_run(
        run_name='sarima_select',
        params={
            'grid_size': len(candidates),
            'cv_initial': CV_INITIAL,
            'cv_step': CV_STEP,
            'cv_horizon': CV_HORIZON,
            'cv_cutoffs': CV_CUTOFFS,
            'train_size': TRAIN_MONTHS,
        },
        metrics={
            'chosen_order': chosen['order'],
            'chosen_seasonal_order': chosen['seasonal_order'],
            'chosen_mean_rmse': chosen['mean_rmse'],
            'chosen_aic': chosen['aic'],
            'n_fitted': len(results_sorted),
            'n_excluded': len(excluded),
        },
    )


if __name__ == '__main__':
    main()
