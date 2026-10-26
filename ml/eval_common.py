"""
Shared data loading, baseline implementations and Prophet configuration for
the SARIMA / rolling-evaluation / significance-testing / error-analysis
scripts (ml/sarima_select.py, ml/sarima_test.py, ml/rolling_evaluation.py,
ml/significance_testing.py, ml/error_analysis.py).

Everything here is copied from — not a reinterpretation of — the existing
pipeline: data loading matches ml/forecast.py, the Prophet default
hyperparameters match ml/train_model.py's PARAMS, the CV-tuned
hyperparameters match ml/best_params.json (changepoint_prior_scale=0.01,
seasonality_prior_scale=1, seasonality_mode='multiplicative' — pinned here
as literal values per the evaluation protocol rather than read live from
best_params.json, so this experiment's "CV-tuned" setting can't silently
drift if someone reruns ml/tune_prophet.py later), and both baselines match
ml/forecast.py / ml/train_model.py exactly (seasonal-naive repeats the last
12 training months; last-year-x-growth scales those same 12 months by the
year-over-year growth observed in training, compounded per additional
year of horizon).
"""

import os

import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from prophet import Prophet
from sklearn.metrics import mean_absolute_error, mean_squared_error

# Load environment variables from .env in the project root
_DOTENV_PATH = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(_DOTENV_PATH)

RESULTS_DIR = os.path.join(os.path.dirname(__file__), 'results')

# Evaluation protocol — fixed 26 October 2026 (01:58 EAT).
TRAIN_MONTHS = 102       # 2014-01 .. 2022-06
TEST_MONTHS = 26         # 2022-07 .. 2024-08
SEASONAL_PERIOD = 12

# Fixed before every Prophet .predict() call (see fit_prophet_and_predict
# below) so every run of this experiment is reproducible. Prophet samples
# from the posterior to build yhat_lower/yhat_upper even under its default
# MAP estimation (mcmc_samples=0), so predict() is seed-sensitive.
RANDOM_SEED = 42

PROPHET_DEFAULT_PARAMS = dict(
    changepoint_prior_scale=0.05,
    seasonality_prior_scale=10,
    seasonality_mode='additive',
)

# Matches ml/best_params.json as of this writing — see module docstring for
# why this is a pinned literal rather than a live read of that file.
PROPHET_TUNED_PARAMS = dict(
    changepoint_prior_scale=0.01,
    seasonality_prior_scale=1,
    seasonality_mode='multiplicative',
)


def ensure_results_dir():
    os.makedirs(RESULTS_DIR, exist_ok=True)
    return RESULTS_DIR


def load_consumption_df():
    """128 monthly totals from izsu_consumption, ascending by date, as a
    two-column (ds, y) DataFrame — Prophet's expected input shape."""
    conn = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        port=os.getenv("DB_PORT"),
    )
    query = "SELECT date, consumption_cleaned_m3 FROM izsu_consumption ORDER BY date"
    df = pd.read_sql(query, conn)
    conn.close()

    df.columns = ['ds', 'y']
    df['ds'] = pd.to_datetime(df['ds'])
    return df.sort_values('ds').reset_index(drop=True)


def evaluate(predictions, actual):
    """MAE / RMSE / MAPE — same formula used throughout ml/."""
    predictions = np.asarray(predictions, dtype=float)
    actual = np.asarray(actual, dtype=float)
    mae = mean_absolute_error(actual, predictions)
    rmse = np.sqrt(mean_squared_error(actual, predictions))
    mape = float(np.mean(np.abs((actual - predictions) / actual)) * 100)
    return {'mae': float(mae), 'rmse': float(rmse), 'mape': mape}


def seasonal_naive_forecast(train_y, horizon):
    """Repeats the last 12 training months in order, wrapping around if
    horizon > 12. Matches ml/forecast.py / ml/train_model.py."""
    last_12 = np.asarray(train_y)[-12:]
    return np.array([last_12[i % 12] for i in range(horizon)])


def last_year_growth_forecast(train_y, horizon):
    """Last-year-x-growth baseline: the matching month from the last 12
    training months, scaled by the year-over-year growth rate observed in
    training, compounded for each additional year ahead. Matches
    ml/forecast.py / ml/train_model.py."""
    train_y = np.asarray(train_y)
    last_12 = train_y[-12:]
    previous_12 = train_y[-24:-12]
    growth_rate = last_12.sum() / previous_12.sum()
    return np.array([
        last_12[i % 12] * (growth_rate ** (1 + i // 12))
        for i in range(horizon)
    ])


def fit_prophet_and_predict(train_df, params, periods, freq='MS'):
    """Fits Prophet on train_df (columns ds, y) with the given
    hyperparameters (changepoint_prior_scale / seasonality_prior_scale /
    seasonality_mode — yearly/weekly/daily seasonality flags are fixed to
    match ml/train_model.py) and returns the last `periods` rows of the
    forecast (ds, yhat, yhat_lower, yhat_upper).

    Seeds numpy immediately before predict(), per the evaluation protocol.
    """
    model = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=False,
        daily_seasonality=False,
        **params,
    )
    model.fit(train_df)
    future = model.make_future_dataframe(periods=periods, freq=freq)
    np.random.seed(RANDOM_SEED)
    forecast = model.predict(future)
    return forecast.tail(periods)[['ds', 'yhat', 'yhat_lower', 'yhat_upper']].reset_index(drop=True)


def get_season(month):
    """Jun-Sep -> summer, Dec-Mar -> winter, else -> other."""
    if month in (6, 7, 8, 9):
        return 'summer'
    if month in (12, 1, 2, 3):
        return 'winter'
    return 'other'
