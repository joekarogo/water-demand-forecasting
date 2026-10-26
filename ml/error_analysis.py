"""
Error analysis on the single 26-month test forecasts of Prophet (defaults)
and the SARIMA setting chosen by ml/sarima_select.py: MAPE by season
(summer Jun-Sep, winter Dec-Mar, other) and the 5 worst months (actual,
forecast, % error) for each model.

Self-contained: refits both models on the 102 training months and
forecasts the 26 test months itself (the same 102/26 split used by
ml/sarima_test.py), rather than depending on that script's saved files.

Run with: python ml/error_analysis.py (after ml/sarima_select.py has
produced ml/results/sarima_select_chosen.json)
Writes: ml/results/error_analysis.json
"""

import json
import os

import numpy as np
from statsmodels.tsa.statespace.sarimax import SARIMAX

from eval_common import (
    PROPHET_DEFAULT_PARAMS,
    TEST_MONTHS,
    TRAIN_MONTHS,
    ensure_results_dir,
    fit_prophet_and_predict,
    get_season,
    load_consumption_df,
)
from run_logger import save_run

CHOSEN_PATH = os.path.join(os.path.dirname(__file__), 'results', 'sarima_select_chosen.json')
N_WORST = 5


def load_chosen_sarima():
    if not os.path.exists(CHOSEN_PATH):
        raise SystemExit(f"ERROR: {CHOSEN_PATH} not found. Run ml/sarima_select.py first.")
    with open(CHOSEN_PATH) as f:
        return json.load(f)


def analyze(label, test_df, yhat):
    rows = test_df.copy()
    rows['yhat'] = yhat
    rows['pct_error'] = (rows['y'] - rows['yhat']) / rows['y'] * 100
    rows['abs_pct_error'] = rows['pct_error'].abs()
    rows['season'] = rows['ds'].dt.month.map(get_season)

    mape_by_season = rows.groupby('season')['abs_pct_error'].mean().to_dict()

    worst = rows.sort_values('abs_pct_error', ascending=False).head(N_WORST)
    worst_months = [
        {
            'date': row.ds.strftime('%Y-%m-%d'),
            'actual': float(row.y),
            'forecast': float(row.yhat),
            'pct_error': float(row.pct_error),
        }
        for row in worst.itertuples()
    ]

    print(f"\n{label}:")
    print("  MAPE by season: " + ", ".join(f"{s}={v:.2f}%" for s, v in sorted(mape_by_season.items())))
    print(f"  {N_WORST} worst months:")
    for w in worst_months:
        print(f"    {w['date']}: actual {w['actual']:,.0f}, forecast {w['forecast']:,.0f}, "
              f"error {w['pct_error']:+.2f}%")

    return {
        'mape_by_season': {s: float(v) for s, v in mape_by_season.items()},
        'worst_months': worst_months,
    }


def main():
    chosen = load_chosen_sarima()
    order = tuple(chosen['order'])
    seasonal_order = tuple(chosen['seasonal_order'])
    sarima_label = f"SARIMA{order}x{seasonal_order}"

    df = load_consumption_df()
    assert len(df) == TRAIN_MONTHS + TEST_MONTHS, (
        f"Expected {TRAIN_MONTHS + TEST_MONTHS} months total, got {len(df)}"
    )
    train = df.iloc[:TRAIN_MONTHS]
    test = df.iloc[TRAIN_MONTHS:].reset_index(drop=True)
    train_y = train['y'].values

    prophet_fc = fit_prophet_and_predict(train[['ds', 'y']], PROPHET_DEFAULT_PARAMS, TEST_MONTHS)
    prophet_result = analyze('Prophet (defaults)', test, prophet_fc['yhat'].values)

    sarima_model = SARIMAX(
        train_y, order=order, seasonal_order=seasonal_order,
        enforce_stationarity=False, enforce_invertibility=False,
    )
    sarima_fit = sarima_model.fit(disp=False)
    sarima_yhat = np.asarray(sarima_fit.get_forecast(steps=TEST_MONTHS).predicted_mean)
    sarima_result = analyze(sarima_label, test, sarima_yhat)

    results_dir = ensure_results_dir()
    payload = {
        'Prophet (defaults)': prophet_result,
        sarima_label: sarima_result,
    }
    with open(os.path.join(results_dir, 'error_analysis.json'), 'w') as f:
        json.dump(payload, f, indent=2)
    print(f"\nSaved to {results_dir}")

    save_run(
        run_name='error_analysis',
        params={
            'train_size': TRAIN_MONTHS,
            'test_size': TEST_MONTHS,
            'sarima_order': list(order),
            'sarima_seasonal_order': list(seasonal_order),
        },
        metrics={
            'Prophet (defaults) mape_by_season': prophet_result['mape_by_season'],
            f'{sarima_label} mape_by_season': sarima_result['mape_by_season'],
        },
    )


if __name__ == '__main__':
    main()
