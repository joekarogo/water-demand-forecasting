"""
E1 test: fits the SARIMA setting chosen by ml/sarima_select.py on the 102
training months, forecasts the 26 test months ONCE with an 80% interval,
and reports MAE/RMSE/MAPE alongside a comparison against Prophet
(defaults), seasonal-naive and last-year-x-growth — all recomputed here on
the exact same 102/26 split, not copied from any earlier run or file.

Run with: python ml/sarima_test.py (after ml/sarima_select.py has produced
ml/results/sarima_select_chosen.json)
Writes:
  ml/results/sarima_test_predictions.csv   (26 rows: date, actual, yhat, lower, upper)
  ml/results/sarima_test_comparison.json   (MAE/RMSE/MAPE for all 4 models)
"""

import json
import os

import numpy as np
import pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX

from eval_common import (
    PROPHET_DEFAULT_PARAMS,
    TEST_MONTHS,
    TRAIN_MONTHS,
    conf_int_bounds,
    ensure_results_dir,
    evaluate,
    fit_prophet_and_predict,
    last_year_growth_forecast,
    load_consumption_df,
    seasonal_naive_forecast,
)
from run_logger import save_run

CHOSEN_PATH = os.path.join(os.path.dirname(__file__), 'results', 'sarima_select_chosen.json')
INTERVAL_WIDTH = 0.8  # matches Prophet's default interval_width used throughout this project


def load_chosen_sarima():
    if not os.path.exists(CHOSEN_PATH):
        raise SystemExit(f"ERROR: {CHOSEN_PATH} not found. Run ml/sarima_select.py first.")
    with open(CHOSEN_PATH) as f:
        return json.load(f)


def main():
    chosen = load_chosen_sarima()
    order = tuple(chosen['order'])
    seasonal_order = tuple(chosen['seasonal_order'])
    print(f"Chosen SARIMA setting: SARIMA{order}x{seasonal_order} "
          f"(selection mean CV RMSE {chosen['mean_rmse']:,.2f} m3, AIC {chosen['aic']:,.2f})")

    df = load_consumption_df()
    assert len(df) == TRAIN_MONTHS + TEST_MONTHS, (
        f"Expected {TRAIN_MONTHS + TEST_MONTHS} months total, got {len(df)}"
    )
    train = df.iloc[:TRAIN_MONTHS]
    test = df.iloc[TRAIN_MONTHS:]
    train_y = train['y'].values
    actual = test['y'].values
    test_dates = test['ds'].dt.strftime('%Y-%m-%d').values

    # --- SARIMA: fit once on the 102 training months, forecast the 26 test
    # months once with an 80% interval. ---
    sarima_model = SARIMAX(
        train_y, order=order, seasonal_order=seasonal_order,
        enforce_stationarity=False, enforce_invertibility=False,
    )
    sarima_fit = sarima_model.fit(disp=False)
    sarima_forecast = sarima_fit.get_forecast(steps=TEST_MONTHS)
    sarima_yhat = np.asarray(sarima_forecast.predicted_mean)
    sarima_lower, sarima_upper = conf_int_bounds(sarima_forecast, alpha=1 - INTERVAL_WIDTH)
    sarima_metrics = evaluate(sarima_yhat, actual)

    sarima_label = f"SARIMA{order}x{seasonal_order}"
    print(f"\n{sarima_label} on the 26-month test set:")
    print(f"  MAE {sarima_metrics['mae']:,.2f} m3 | RMSE {sarima_metrics['rmse']:,.2f} m3 | "
          f"MAPE {sarima_metrics['mape']:.2f}%")

    predictions_df = pd.DataFrame({
        'date': test_dates,
        'actual': actual,
        'yhat': sarima_yhat,
        'lower': sarima_lower,
        'upper': sarima_upper,
    })

    # --- Comparison models, recomputed here (not copied from any earlier
    # run/file) on the exact same 102/26 split. ---
    prophet_forecast = fit_prophet_and_predict(train[['ds', 'y']], PROPHET_DEFAULT_PARAMS, TEST_MONTHS)
    prophet_metrics = evaluate(prophet_forecast['yhat'].values, actual)

    seasonal_naive_pred = seasonal_naive_forecast(train_y, TEST_MONTHS)
    seasonal_naive_metrics = evaluate(seasonal_naive_pred, actual)

    growth_pred = last_year_growth_forecast(train_y, TEST_MONTHS)
    growth_metrics = evaluate(growth_pred, actual)

    comparison = {
        sarima_label: sarima_metrics,
        'Prophet (defaults)': prophet_metrics,
        'Seasonal-naive': seasonal_naive_metrics,
        'Last-year x growth': growth_metrics,
    }

    print(f"\n{'Model':<30} {'MAE (m3)':>18} {'RMSE (m3)':>18} {'MAPE':>8}")
    print('-' * 78)
    for label, m in comparison.items():
        print(f"{label:<30} {m['mae']:>18,.2f} {m['rmse']:>18,.2f} {m['mape']:>7.2f}%")

    results_dir = ensure_results_dir()
    predictions_df.to_csv(os.path.join(results_dir, 'sarima_test_predictions.csv'), index=False)

    comparison_payload = {
        'chosen_sarima_order': list(order),
        'chosen_sarima_seasonal_order': list(seasonal_order),
        'interval_width': INTERVAL_WIDTH,
        'metrics': comparison,
    }
    with open(os.path.join(results_dir, 'sarima_test_comparison.json'), 'w') as f:
        json.dump(comparison_payload, f, indent=2)

    print(f"\nPredictions and comparison saved to {results_dir}")

    save_run(
        run_name='sarima_test',
        params={
            'sarima_order': list(order),
            'sarima_seasonal_order': list(seasonal_order),
            'interval_width': INTERVAL_WIDTH,
            'train_size': TRAIN_MONTHS,
            'test_size': TEST_MONTHS,
        },
        metrics=comparison,
        predictions_df=predictions_df,
    )


if __name__ == '__main__':
    main()
