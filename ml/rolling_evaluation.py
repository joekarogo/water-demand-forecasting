"""
E3 rolling evaluation: at each of 15 origins (the last known month from
2022-06 to 2023-08), refits every model on all data up to and including
that origin and forecasts 12 months ahead. Settings are fixed — this
script does no model selection of its own.

Models: Prophet (defaults), Prophet (CV-tuned: changepoint_prior_scale=0.01,
seasonality_prior_scale=1, seasonality_mode='multiplicative'), the SARIMA
setting chosen by ml/sarima_select.py, seasonal-naive, last-year-x-growth.

Every prediction (origin, horizon 1..12, target month, actual, yhat, lower,
upper) is saved. MAPE is reported by horizon (1..12, with 3/6/12
highlighted) for every model, and 80% interval coverage by horizon is
reported for Prophet (defaults) and the chosen SARIMA only — those are the
only two models here with a real predictive interval.

NOTE: forecasts from overlapping origins are not independent observations,
so the coverage figures below are descriptive, not a formal hypothesis
test.

Run with: python ml/rolling_evaluation.py (after ml/sarima_select.py has
produced ml/results/sarima_select_chosen.json)
Writes:
  ml/results/rolling_evaluation_predictions.csv  (every origin x horizon x model row)
  ml/results/rolling_evaluation_summary.json     (MAPE by horizon per model + coverage)
"""

import json
import os

import numpy as np
import pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX

from eval_common import (
    PROPHET_DEFAULT_PARAMS,
    PROPHET_TUNED_PARAMS,
    ensure_results_dir,
    fit_prophet_and_predict,
    last_year_growth_forecast,
    load_consumption_df,
    seasonal_naive_forecast,
)
from run_logger import save_run

CHOSEN_PATH = os.path.join(os.path.dirname(__file__), 'results', 'sarima_select_chosen.json')
HORIZON = 12
ORIGIN_START = '2022-06-01'
ORIGIN_END = '2023-08-01'
INTERVAL_WIDTH = 0.8
HIGHLIGHT_HORIZONS = (3, 6, 12)


def load_chosen_sarima():
    if not os.path.exists(CHOSEN_PATH):
        raise SystemExit(f"ERROR: {CHOSEN_PATH} not found. Run ml/sarima_select.py first.")
    with open(CHOSEN_PATH) as f:
        return json.load(f)


def sarima_forecast(train_y, order, seasonal_order, periods):
    model = SARIMAX(
        train_y, order=order, seasonal_order=seasonal_order,
        enforce_stationarity=False, enforce_invertibility=False,
    )
    fit = model.fit(disp=False)
    forecast = fit.get_forecast(steps=periods)
    yhat = np.asarray(forecast.predicted_mean)
    ci = forecast.conf_int(alpha=1 - INTERVAL_WIDTH)
    lower = np.asarray(ci.iloc[:, 0])
    upper = np.asarray(ci.iloc[:, 1])
    return yhat, lower, upper


def main():
    chosen = load_chosen_sarima()
    sarima_order = tuple(chosen['order'])
    sarima_seasonal_order = tuple(chosen['seasonal_order'])
    sarima_label = f"SARIMA{sarima_order}x{sarima_seasonal_order}"

    df = load_consumption_df()
    origin_mask = (df['ds'] >= ORIGIN_START) & (df['ds'] <= ORIGIN_END)
    origin_indices = df.index[origin_mask].tolist()
    print(f"{len(origin_indices)} origins: {df.loc[origin_indices[0], 'ds'].date()} "
          f"to {df.loc[origin_indices[-1], 'ds'].date()}")

    max_target_index = origin_indices[-1] + HORIZON
    if max_target_index >= len(df):
        raise SystemExit(
            f"ERROR: last origin + {HORIZON} months (index {max_target_index}) exceeds "
            f"the available data ({len(df)} months)."
        )

    records = []

    for origin_index in origin_indices:
        origin_date = df.loc[origin_index, 'ds']
        train_df = df.iloc[:origin_index + 1][['ds', 'y']].reset_index(drop=True)
        train_y = train_df['y'].values
        print(f"\nOrigin {origin_date.date()} ({len(train_df)} months of history)...")

        targets = df.iloc[origin_index + 1: origin_index + 1 + HORIZON]
        target_dates = targets['ds'].values
        target_actuals = targets['y'].values

        model_forecasts = {}

        prophet_default_fc = fit_prophet_and_predict(train_df, PROPHET_DEFAULT_PARAMS, HORIZON)
        model_forecasts['Prophet (defaults)'] = (
            prophet_default_fc['yhat'].values,
            prophet_default_fc['yhat_lower'].values,
            prophet_default_fc['yhat_upper'].values,
        )

        prophet_tuned_fc = fit_prophet_and_predict(train_df, PROPHET_TUNED_PARAMS, HORIZON)
        model_forecasts['Prophet (CV-tuned)'] = (
            prophet_tuned_fc['yhat'].values,
            prophet_tuned_fc['yhat_lower'].values,
            prophet_tuned_fc['yhat_upper'].values,
        )

        sarima_yhat, sarima_lower, sarima_upper = sarima_forecast(
            train_y, sarima_order, sarima_seasonal_order, HORIZON
        )
        model_forecasts[sarima_label] = (sarima_yhat, sarima_lower, sarima_upper)

        seasonal_naive_pred = seasonal_naive_forecast(train_y, HORIZON)
        model_forecasts['Seasonal-naive'] = (
            seasonal_naive_pred, np.full(HORIZON, np.nan), np.full(HORIZON, np.nan)
        )

        growth_pred = last_year_growth_forecast(train_y, HORIZON)
        model_forecasts['Last-year x growth'] = (
            growth_pred, np.full(HORIZON, np.nan), np.full(HORIZON, np.nan)
        )

        for model_name, (yhat, lower, upper) in model_forecasts.items():
            for h in range(HORIZON):
                records.append({
                    'origin': origin_date.strftime('%Y-%m-%d'),
                    'horizon': h + 1,
                    'target_month': pd.Timestamp(target_dates[h]).strftime('%Y-%m-%d'),
                    'model': model_name,
                    'actual': float(target_actuals[h]),
                    'yhat': float(yhat[h]),
                    'lower': float(lower[h]) if not np.isnan(lower[h]) else None,
                    'upper': float(upper[h]) if not np.isnan(upper[h]) else None,
                })

    predictions_df = pd.DataFrame.from_records(records)
    predictions_df['abs_pct_error'] = (
        np.abs((predictions_df['actual'] - predictions_df['yhat']) / predictions_df['actual']) * 100
    )

    # --- MAPE by horizon, per model. ---
    mape_by_horizon = (
        predictions_df.groupby(['model', 'horizon'])['abs_pct_error']
        .mean()
        .reset_index()
        .rename(columns={'abs_pct_error': 'mape'})
    )

    print("\n=== MAPE by horizon (highlighting 3, 6, 12) ===")
    mape_summary = {}
    for model_name in predictions_df['model'].unique():
        model_rows = mape_by_horizon[mape_by_horizon['model'] == model_name].set_index('horizon')['mape']
        mape_summary[model_name] = {int(h): float(v) for h, v in model_rows.items()}
        highlights = ", ".join(f"h{h}={model_rows.get(h, float('nan')):.2f}%" for h in HIGHLIGHT_HORIZONS)
        print(f"{model_name:<22} {highlights}")

    # --- 80% interval coverage by horizon, for Prophet (defaults) and
    # SARIMA only (the only two models here with a real interval). ---
    coverage_summary = {}
    for model_name in ['Prophet (defaults)', sarima_label]:
        model_rows = predictions_df[predictions_df['model'] == model_name].copy()
        model_rows['covered'] = (
            (model_rows['actual'] >= model_rows['lower']) & (model_rows['actual'] <= model_rows['upper'])
        )
        coverage_by_h = model_rows.groupby('horizon')['covered'].mean()
        coverage_summary[model_name] = {int(h): float(v) for h, v in coverage_by_h.items()}

    print(f"\n=== 80% interval coverage by horizon (Prophet defaults, {sarima_label}) ===")
    print("NOTE: forecasts from overlapping origins are not independent observations, "
          "so these coverage figures are descriptive, not a formal hypothesis test.")
    for model_name, by_h in coverage_summary.items():
        highlights = ", ".join(f"h{h}={by_h.get(h, float('nan')) * 100:.0f}%" for h in HIGHLIGHT_HORIZONS)
        print(f"{model_name:<22} {highlights}")

    results_dir = ensure_results_dir()
    predictions_df.to_csv(os.path.join(results_dir, 'rolling_evaluation_predictions.csv'), index=False)

    summary_payload = {
        'origins': [df.loc[i, 'ds'].strftime('%Y-%m-%d') for i in origin_indices],
        'horizon': HORIZON,
        'sarima_label': sarima_label,
        'interval_width': INTERVAL_WIDTH,
        'mape_by_horizon': mape_summary,
        'coverage_by_horizon': coverage_summary,
        'coverage_caveat': (
            "Forecasts from overlapping origins are not independent observations; "
            "coverage here is descriptive, not a formal test."
        ),
    }
    with open(os.path.join(results_dir, 'rolling_evaluation_summary.json'), 'w') as f:
        json.dump(summary_payload, f, indent=2)

    print(f"\nPredictions and summary saved to {results_dir}")

    save_run(
        run_name='rolling_evaluation',
        params={
            'origins': summary_payload['origins'],
            'horizon': HORIZON,
            'sarima_order': list(sarima_order),
            'sarima_seasonal_order': list(sarima_seasonal_order),
            'interval_width': INTERVAL_WIDTH,
        },
        metrics={
            'mape_by_horizon': mape_summary,
            'coverage_by_horizon': coverage_summary,
        },
        predictions_df=predictions_df,
    )


if __name__ == '__main__':
    main()
