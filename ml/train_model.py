import pandas as pd
import psycopg2
from prophet import Prophet
from sklearn.metrics import mean_absolute_error, mean_squared_error
import numpy as np
import joblib
import json
import os
import warnings
from datetime import datetime
from dotenv import load_dotenv
from run_logger import save_run
warnings.filterwarnings('ignore')

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

DEFAULT_MODEL_PATH = r"G:\My Drive\water-demand-forecasting\models\prophet_model.pkl"
MODEL_PATH = os.getenv("MODEL_PATH", DEFAULT_MODEL_PATH)
METRICS_PATH = os.path.join(os.path.dirname(MODEL_PATH), 'model_metrics.json')

PARAMS = dict(
    yearly_seasonality=True,
    weekly_seasonality=False,
    daily_seasonality=False,
    changepoint_prior_scale=0.05,
    seasonality_prior_scale=10,
    seasonality_mode='additive'
)


def evaluate(predictions, actual):
    mae = mean_absolute_error(actual, predictions)
    rmse = np.sqrt(mean_squared_error(actual, predictions))
    mape = np.mean(np.abs((actual - predictions) / actual)) * 100
    return {'mae': mae, 'rmse': rmse, 'mape': mape}


# Connect to database
conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT")
)

# Load consumption data from izsu_consumption (official IZSU billed data).
query = "SELECT date, consumption_cleaned_m3 FROM izsu_consumption ORDER BY date"
df = pd.read_sql(query, conn)
conn.close()

df.columns = ['ds', 'y']
df['ds'] = pd.to_datetime(df['ds'])
df = df.sort_values('ds').reset_index(drop=True)

print(f"Data loaded: {len(df)} records")
print(f"Date range: {df['ds'].min()} to {df['ds'].max()}")

# Train test split—80/20
split_index = int(len(df) * 0.8)
train = df[:split_index]
test = df[split_index:]
actuals = test['y'].values

print(f"Training records: {len(train)}")
print(f"Testing records: {len(test)}")

# Prophet test-set evaluation (default hyperparameters)
model = Prophet(**PARAMS)
model.fit(train)
future = model.make_future_dataframe(periods=len(test), freq='MS')
forecast = model.predict(future)
predictions = forecast['yhat'].tail(len(test)).values
prophet_metrics = evaluate(predictions, actuals)

print(f"\nModel Evaluation:")
print(f"MAE: {prophet_metrics['mae']:,.2f} m3")
print(f"RMSE: {prophet_metrics['rmse']:,.2f} m3")
print(f"MAPE: {prophet_metrics['mape']:,.2f}%")

# Seasonal-naive baseline: repeat the last 12 training months in order.
last_12_train = train['y'].values[-12:]
seasonal_naive_predictions = np.array([last_12_train[i % 12] for i in range(len(test))])
seasonal_naive_metrics = evaluate(seasonal_naive_predictions, actuals)

print(f"\nSeasonal-Naive Baseline:")
print(f"Baseline MAE: {seasonal_naive_metrics['mae']:,.2f} m3")
print(f"Baseline RMSE: {seasonal_naive_metrics['rmse']:,.2f} m3")
print(f"Baseline MAPE: {seasonal_naive_metrics['mape']:,.2f}%")

# Last-year x growth baseline.
previous_12_train = train['y'].values[-24:-12]
growth_rate = last_12_train.sum() / previous_12_train.sum()
growth_predictions = np.array([
    last_12_train[i % 12] * (growth_rate ** (1 + i // 12))
    for i in range(len(test))
])
growth_metrics = evaluate(growth_predictions, actuals)

print(f"\nLast-Year x Growth Baseline:")
print(f"Growth MAE: {growth_metrics['mae']:,.2f} m3")
print(f"Growth RMSE: {growth_metrics['rmse']:,.2f} m3")
print(f"Growth MAPE: {growth_metrics['mape']:,.2f}%")

# Retrain on all data and save — this is the model ml/publish_forecast.py will load.
final_model = Prophet(**PARAMS)
final_model.fit(df)
print(f"\nFinal model retrained on all {len(df)} records")

os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
joblib.dump(final_model, MODEL_PATH)
print(f"Final model saved to {MODEL_PATH}")

metrics_payload = {
    'generated_at': datetime.now().isoformat(),
    'model_name': 'Prophet (default settings)',
    'hyperparameters': {
        'changepoint_prior_scale': PARAMS['changepoint_prior_scale'],
        'seasonality_prior_scale': PARAMS['seasonality_prior_scale'],
        'seasonality_mode': PARAMS['seasonality_mode'],
    },
    'train_size': len(train),
    'test_size': len(test),
    'prophet': prophet_metrics,
    'seasonal_naive': seasonal_naive_metrics,
    'last_year_growth': growth_metrics,
}

with open(METRICS_PATH, 'w') as f:
    json.dump(metrics_payload, f, indent=2, default=str)
print(f"Metrics saved to {METRICS_PATH}")

save_run(
    run_name='train_model',
    params={
        **{k: v for k, v in PARAMS.items() if k not in ('yearly_seasonality', 'weekly_seasonality', 'daily_seasonality')},
        'train_size': len(train),
        'test_size': len(test),
    },
    metrics={
        'prophet': prophet_metrics,
        'seasonal_naive': seasonal_naive_metrics,
        'last_year_growth': growth_metrics,
    },
)
