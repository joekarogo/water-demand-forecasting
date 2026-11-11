"""
Publishes a genuine 12-month-ahead forecast of the newly-adopted model: the
50/50 ensemble of Prophet (defaults) and the chosen SARIMA setting, with the
E1b split-conformal 80% range (see docs/experiment_protocol_2.md, "E4
outcome and E1b" -- E4 found the ensemble wins the selection rule, E1b
calibrated the range it needs because the ensemble itself defines none).

This is NOT a rolling-origin or held-out-test evaluation -- both models are
fit on the COMPLETE consumption series (every month on record), exactly as
ml/publish_forecast.py fits its Prophet model on the complete series, and
forecast 12 months beyond the last known month. There is no future data to
hold out.

What this script reads (never recomputes, never hard-codes the numbers):
  - izsu_consumption, via eval_common.load_consumption_df() -- always from
    the LOCAL database (the .env DB_* vars), regardless of --database-url.
  - ml/results/sarima_select_chosen.json, via
    rolling_evaluation.load_chosen_sarima() -- the chosen SARIMA order /
    seasonal_order.
  - ml/results/ensemble_conformal.json -- E1b's calibration.q_lo_by_horizon
    / calibration.q_hi_by_horizon (signed fractional offsets, keyed "1".."12").
  - ml/results/ensemble_experiment.json -- E4's 26-month test mae/rmse/mape
    for the Ensemble (50/50), stored under test_evaluation.metrics.

What this script writes (one transaction, --publish only, never deletes or
overwrites any earlier forecast -- always a fresh INSERT):
  - one forecasts row (kind='published', model_name='Ensemble (Prophet +
    SARIMA, 50/50)', mae/rmse/mape from ml/results/ensemble_experiment.json,
    data_up_to/train_start/train_end = the fitted series' own last/first/last
    month, horizon=12, interval_width=0.80)
  - 12 forecast_results rows (date, predicted_value=yhat, yhat_lower=lower,
    yhat_upper=upper)
  - one audit_log row (action='forecast_published', user_id=NULL,
    entity='forecasts', entity_id=<new forecast_id>, details={'model_name',
    'horizon', 'data_up_to', 'method': 'ensemble 50/50 + split-conformal 80%
    range'})

Target database:
  - Default: the local database from the project root .env (DB_HOST /
    DB_NAME / DB_USER / DB_PASSWORD / DB_PORT), exactly like
    ml/publish_forecast.py.
  - --database-url <url>: connects to that URL instead (sslmode=require),
    for publishing to Heroku. The model is still always FIT on the local
    database's data (there is no "load consumption from the target" path);
    this flag only changes where the result is written/compared. Before
    fitting or writing anything, the target's own izsu_consumption row
    count and first/last month are checked against the local data used for
    fitting -- if they don't match, the script stops with a clear error and
    touches nothing.

--dry-run is the DEFAULT (i.e. omitting --publish): fits both models,
computes and prints the 12-month yhat/lower/upper and the exact forecasts
row that would be inserted, then prints a side-by-side comparison against
the target database's CURRENT latest kind='published' forecast (model_name,
mape, and each month's yhat/upper next to the new ensemble's own). It
performs no INSERT of any kind. Only --publish performs the write and
commits it.

Run with:
  py -3.13 ml/publish_ensemble_forecast.py            (dry run, local)
  py -3.13 ml/publish_ensemble_forecast.py --publish  (write, local)
  py -3.13 ml/publish_ensemble_forecast.py --database-url $env:HEROKU_DB            (dry run, Heroku)
  py -3.13 ml/publish_ensemble_forecast.py --database-url $env:HEROKU_DB --publish  (write, Heroku)
"""

import argparse
import json
import os

import numpy as np
import pandas as pd
import psycopg2
from psycopg2.extras import Json
from dotenv import load_dotenv

from eval_common import (
    PROPHET_DEFAULT_PARAMS,
    RANDOM_SEED,
    fit_prophet_and_predict,
    load_consumption_df,
)
from rolling_evaluation import load_chosen_sarima, sarima_forecast

DOTENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env')
RESULTS_DIR = os.path.join(os.path.dirname(__file__), 'results')
ENSEMBLE_CONFORMAL_PATH = os.path.join(RESULTS_DIR, 'ensemble_conformal.json')
ENSEMBLE_EXPERIMENT_PATH = os.path.join(RESULTS_DIR, 'ensemble_experiment.json')

HORIZON = 12
INTERVAL_WIDTH = 0.80
WEIGHT_PROPHET = 0.5
WEIGHT_SARIMA = 0.5
MODEL_NAME = 'Ensemble (Prophet + SARIMA, 50/50)'
ENSEMBLE_LABEL = 'Ensemble (50/50)'  # matches ml/ensemble_experiment.py's own constant


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        '--publish', action='store_true', default=False,
        help='Actually write the forecast (default: dry run, no database writes).',
    )
    parser.add_argument(
        '--database-url', default=None,
        help='Connect to this database URL instead of the local .env database (sslmode=require).',
    )
    return parser.parse_args()


def connect_target(args):
    if args.database_url:
        return psycopg2.connect(args.database_url, sslmode='require')
    load_dotenv(DOTENV_PATH)
    return psycopg2.connect(
        host=os.getenv('DB_HOST'),
        database=os.getenv('DB_NAME'),
        user=os.getenv('DB_USER'),
        password=os.getenv('DB_PASSWORD'),
        port=os.getenv('DB_PORT'),
    )


def check_target_consistency(conn, df):
    """Only called when --database-url is given. Confirms the target's own
    izsu_consumption matches the LOCAL data this script fits on, before
    anything is fit or written. Raises SystemExit on any mismatch."""
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*), MIN(date), MAX(date) FROM izsu_consumption')
    target_count, target_min, target_max = cursor.fetchone()
    cursor.close()

    local_count = len(df)
    local_min = df['ds'].min().date()
    local_max = df['ds'].max().date()

    if target_count != local_count or target_min != local_min or target_max != local_max:
        raise SystemExit(
            f"ERROR: target database's izsu_consumption does not match the local data "
            f"this script fits on.\n"
            f"  local:  {local_count} rows, {local_min} .. {local_max}\n"
            f"  target: {target_count} rows, {target_min} .. {target_max}\n"
            "Stopping -- refusing to fit or write anything against a target that is out "
            "of sync with the data used to produce the forecast."
        )


def load_conformal_quantiles():
    if not os.path.exists(ENSEMBLE_CONFORMAL_PATH):
        raise SystemExit(
            f"ERROR: {ENSEMBLE_CONFORMAL_PATH} not found. Run ml/ensemble_conformal.py first."
        )
    with open(ENSEMBLE_CONFORMAL_PATH) as f:
        payload = json.load(f)
    q_lo_by_horizon = payload['calibration']['q_lo_by_horizon']
    q_hi_by_horizon = payload['calibration']['q_hi_by_horizon']
    for h in range(1, HORIZON + 1):
        if str(h) not in q_lo_by_horizon or str(h) not in q_hi_by_horizon:
            raise SystemExit(
                f"ERROR: {ENSEMBLE_CONFORMAL_PATH} is missing q_lo/q_hi for horizon {h}."
            )
    return q_lo_by_horizon, q_hi_by_horizon


def load_ensemble_test_metrics():
    if not os.path.exists(ENSEMBLE_EXPERIMENT_PATH):
        raise SystemExit(
            f"ERROR: {ENSEMBLE_EXPERIMENT_PATH} not found. Run ml/ensemble_experiment.py first."
        )
    with open(ENSEMBLE_EXPERIMENT_PATH) as f:
        payload = json.load(f)
    metrics = payload['test_evaluation']['metrics'].get(ENSEMBLE_LABEL)
    if metrics is None:
        raise SystemExit(
            f"ERROR: {ENSEMBLE_EXPERIMENT_PATH}'s test_evaluation.metrics has no "
            f"{ENSEMBLE_LABEL!r} entry."
        )
    return metrics['mae'], metrics['rmse'], metrics['mape']


def fit_future_ensemble(df, sarima_order, sarima_seasonal_order):
    """Fits Prophet (defaults) and the chosen SARIMA on the COMPLETE
    consumption series and returns (dates, prophet_yhat, sarima_yhat,
    ensemble_yhat), each of length HORIZON."""
    train_df = df[['ds', 'y']].reset_index(drop=True)

    prophet_forecast = fit_prophet_and_predict(train_df, PROPHET_DEFAULT_PARAMS, HORIZON)
    dates = prophet_forecast['ds'].reset_index(drop=True)
    prophet_yhat = prophet_forecast['yhat'].values

    # Independently generated, as a cross-check against Prophet's own dates
    # rather than trusting them blindly.
    expected_dates = pd.date_range(
        start=df['ds'].max(), periods=HORIZON + 1, freq='MS'
    )[1:]
    actual_dates = pd.DatetimeIndex(dates)
    if not actual_dates.equals(expected_dates):
        raise SystemExit(
            f"ERROR: Prophet's forecast dates do not match the expected 12 consecutive "
            f"month-starts after the data's last month.\n"
            f"  Prophet:  {list(actual_dates.strftime('%Y-%m-%d'))}\n"
            f"  expected: {list(expected_dates.strftime('%Y-%m-%d'))}"
        )

    sarima_yhat, _, _ = sarima_forecast(
        df['y'].values, sarima_order, sarima_seasonal_order, HORIZON
    )
    if len(sarima_yhat) != HORIZON:
        raise SystemExit(
            f"ERROR: SARIMA forecast returned {len(sarima_yhat)} values, expected {HORIZON}."
        )

    ensemble_yhat = WEIGHT_PROPHET * prophet_yhat + WEIGHT_SARIMA * sarima_yhat
    return dates, prophet_yhat, sarima_yhat, ensemble_yhat


def build_bounds(ensemble_yhat, q_lo_by_horizon, q_hi_by_horizon):
    lower = np.array([
        ensemble_yhat[h - 1] * (1 + q_lo_by_horizon[str(h)]) for h in range(1, HORIZON + 1)
    ])
    upper = np.array([
        ensemble_yhat[h - 1] * (1 + q_hi_by_horizon[str(h)]) for h in range(1, HORIZON + 1)
    ])
    return lower, upper


def fetch_latest_published(conn):
    """Read-only. Returns None if no forecast has ever been published."""
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT forecast_id, model_name, mape, data_up_to
        FROM forecasts
        WHERE kind = 'published'
        ORDER BY generated_at DESC
        LIMIT 1
        """
    )
    row = cursor.fetchone()
    if row is None:
        cursor.close()
        return None

    forecast_id, model_name, mape, data_up_to = row
    cursor.execute(
        """
        SELECT date, predicted_value, yhat_upper
        FROM forecast_results
        WHERE forecast_id = %s
        ORDER BY date
        """,
        (forecast_id,),
    )
    results = {str(r[0]): {'yhat': r[1], 'upper': r[2]} for r in cursor.fetchall()}
    cursor.close()
    return {
        'forecast_id': forecast_id,
        'model_name': model_name,
        'mape': mape,
        'data_up_to': str(data_up_to),
        'results_by_date': results,
    }


def print_forecast_table(dates, prophet_yhat, sarima_yhat, ensemble_yhat, lower, upper):
    print("\n12-month ensemble forecast:")
    for i in range(HORIZON):
        print(
            f"  {dates[i].strftime('%Y-%m-%d')}: prophet={prophet_yhat[i]:,.0f}  "
            f"sarima={sarima_yhat[i]:,.0f}  ensemble_yhat={ensemble_yhat[i]:,.0f}  "
            f"lower={lower[i]:,.0f}  upper={upper[i]:,.0f}"
        )


def print_forecasts_row(model_name, mae, rmse, mape, data_up_to, train_start, train_end):
    print("\nforecasts row that would be inserted (kind='published'):")
    print(f"  model_name     = {model_name!r}")
    print(f"  mae            = {mae:,.4f}")
    print(f"  rmse           = {rmse:,.4f}")
    print(f"  mape           = {mape:.6f}")
    print(f"  data_up_to     = {data_up_to}")
    print(f"  train_start    = {train_start}")
    print(f"  train_end      = {train_end}")
    print(f"  horizon        = {HORIZON}")
    print(f"  interval_width = {INTERVAL_WIDTH}")


def print_comparison(latest, dates, ensemble_yhat, upper):
    print("\nComparison with the target database's current latest published forecast:")
    if latest is None:
        print("  (none found -- this would be the first published forecast in this database)")
        return

    print(f"  current: model_name={latest['model_name']!r}  mape={latest['mape']:.6f}  "
          f"data_up_to={latest['data_up_to']}")
    print(f"  new:     model_name={MODEL_NAME!r}")
    print(f"\n  {'month':<12}{'current yhat':>16}{'current upper':>16}{'new yhat':>16}{'new upper':>16}")
    current_dates = set(latest['results_by_date'].keys())
    new_dates = set(d.strftime('%Y-%m-%d') for d in dates)
    for i in range(HORIZON):
        date_str = dates[i].strftime('%Y-%m-%d')
        current_row = latest['results_by_date'].get(date_str)
        current_yhat_str = f"{current_row['yhat']:,.0f}" if current_row else '(none)'
        current_upper_str = f"{current_row['upper']:,.0f}" if current_row else '(none)'
        print(
            f"  {date_str:<12}{current_yhat_str:>16}{current_upper_str:>16}"
            f"{ensemble_yhat[i]:>16,.0f}{upper[i]:>16,.0f}"
        )
    only_current = current_dates - new_dates
    only_new = new_dates - current_dates
    if only_current:
        print(f"\n  Months only in the current published forecast: {sorted(only_current)}")
    if only_new:
        print(f"  Months only in the new ensemble forecast: {sorted(only_new)}")


def write_forecast(conn, dates, ensemble_yhat, lower, upper, model_name, mae, rmse, mape,
                    data_up_to, train_start, train_end):
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            INSERT INTO forecasts
                (user_id, generated_at, kind, horizon, model_name, mae, rmse, mape,
                 data_up_to, train_start, train_end, interval_width)
            VALUES (NULL, NOW(), 'published', %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING forecast_id, generated_at
            """,
            (HORIZON, model_name, mae, rmse, mape, data_up_to, train_start, train_end,
             INTERVAL_WIDTH),
        )
        forecast_id, published_at = cursor.fetchone()

        for i in range(HORIZON):
            cursor.execute(
                """
                INSERT INTO forecast_results (forecast_id, date, predicted_value, yhat_lower, yhat_upper)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (forecast_id, dates[i].date(), float(ensemble_yhat[i]), float(lower[i]), float(upper[i])),
            )

        cursor.execute(
            """
            INSERT INTO audit_log (user_id, action, entity, entity_id, details)
            VALUES (NULL, 'forecast_published', 'forecasts', %s, %s)
            """,
            (str(forecast_id), Json({
                'model_name': model_name,
                'horizon': HORIZON,
                'data_up_to': str(data_up_to),
                'method': 'ensemble 50/50 + split-conformal 80% range',
            })),
        )

        conn.commit()
    except Exception:
        conn.rollback()
        cursor.close()
        raise
    cursor.close()
    return forecast_id, published_at


def main():
    np.random.seed(RANDOM_SEED)
    args = parse_args()

    print("=== Publish: Ensemble (50/50) forecast, E1b conformal 80% range ===")

    df = load_consumption_df()
    target_conn = connect_target(args)

    if args.database_url:
        print("\nChecking target database's izsu_consumption against the local fitting data...")
        check_target_consistency(target_conn, df)
        print("  PASS -- row count and date range match.")

    chosen = load_chosen_sarima()
    sarima_order = tuple(chosen['order'])
    sarima_seasonal_order = tuple(chosen['seasonal_order'])

    print(f"\nFitting Prophet (defaults) and SARIMA{sarima_order}x{sarima_seasonal_order} "
          f"on the complete series ({len(df)} months, {df['ds'].min().date()} .. "
          f"{df['ds'].max().date()})...")
    dates, prophet_yhat, sarima_yhat, ensemble_yhat = fit_future_ensemble(
        df, sarima_order, sarima_seasonal_order
    )

    q_lo_by_horizon, q_hi_by_horizon = load_conformal_quantiles()
    lower, upper = build_bounds(ensemble_yhat, q_lo_by_horizon, q_hi_by_horizon)

    mae, rmse, mape = load_ensemble_test_metrics()
    data_up_to = df['ds'].max().date()
    train_start = df['ds'].min().date()
    train_end = data_up_to

    print_forecast_table(dates, prophet_yhat, sarima_yhat, ensemble_yhat, lower, upper)
    print_forecasts_row(MODEL_NAME, mae, rmse, mape, data_up_to, train_start, train_end)

    if not args.publish:
        latest = fetch_latest_published(target_conn)
        print_comparison(latest, dates, ensemble_yhat, upper)
        target_conn.close()
        print("\nDry run only -- nothing was written to the database. Pass --publish to write.")
        return

    forecast_id, published_at = write_forecast(
        target_conn, dates, ensemble_yhat, lower, upper, MODEL_NAME, mae, rmse, mape,
        data_up_to, train_start, train_end,
    )
    target_conn.close()
    print(f"\nPublished forecast_id {forecast_id} at {published_at}")


if __name__ == '__main__':
    main()
