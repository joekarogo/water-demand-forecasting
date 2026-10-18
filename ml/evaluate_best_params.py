import pandas as pd
import psycopg2
from prophet import Prophet
from sklearn.metrics import mean_absolute_error, mean_squared_error
import numpy as np
import json
import os
import warnings
from dotenv import load_dotenv
warnings.filterwarnings('ignore')

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

# Connect to database
conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT")
)

query = "SELECT date, consumption_cleaned_m3 FROM izsu_consumption ORDER BY date"
df = pd.read_sql(query, conn)
conn.close()

df.columns = ['ds', 'y']
df['ds'] = pd.to_datetime(df['ds'])
df = df.sort_values('ds').reset_index(drop=True)

split_index = int(len(df) * 0.8)
train = df[:split_index]
test = df[split_index:]
actuals = test['y'].values


def evaluate(predictions, label):
    mae = mean_absolute_error(actuals, predictions)
    rmse = np.sqrt(mean_squared_error(actuals, predictions))
    mape = np.mean(np.abs((actuals - predictions) / actuals)) * 100
    return {'label': label, 'mae': mae, 'rmse': rmse, 'mape': mape}


results = []

# (a) Prophet defaults
default_model = Prophet(
    yearly_seasonality=True,
    weekly_seasonality=False,
    daily_seasonality=False,
    changepoint_prior_scale=0.05,
    seasonality_prior_scale=10,
    seasonality_mode='additive'
)
default_model.fit(train)
default_future = default_model.make_future_dataframe(periods=len(test), freq='MS')
default_predictions = default_model.predict(default_future)['yhat'].tail(len(test)).values
results.append(evaluate(default_predictions, 'Prophet Defaults'))

# (b) Seasonal-naive baseline
last_12_train = train['y'].values[-12:]
baseline_predictions = np.array([last_12_train[i % 12] for i in range(len(test))])
results.append(evaluate(baseline_predictions, 'Seasonal-Naive Baseline'))

# (c) Prophet with best tuned params from ml/best_params.json
best_params_path = os.path.join(os.path.dirname(__file__), 'best_params.json')
with open(best_params_path) as f:
    best_params = json.load(f)

tuned_model = Prophet(
    yearly_seasonality=True,
    weekly_seasonality=False,
    daily_seasonality=False,
    changepoint_prior_scale=best_params['changepoint_prior_scale'],
    seasonality_prior_scale=best_params['seasonality_prior_scale'],
    seasonality_mode=best_params['seasonality_mode']
)
tuned_model.fit(train)
tuned_future = tuned_model.make_future_dataframe(periods=len(test), freq='MS')
tuned_predictions = tuned_model.predict(tuned_future)['yhat'].tail(len(test)).values
tuned_label = (f"Prophet Tuned (cp={best_params['changepoint_prior_scale']}, "
               f"sp={best_params['seasonality_prior_scale']}, "
               f"mode={best_params['seasonality_mode']})")
results.append(evaluate(tuned_predictions, tuned_label))

print(f"\nTest set comparison ({len(test)} held-out months):\n")
print(f"{'Model':<55} {'MAE (m3)':>18} {'RMSE (m3)':>18} {'MAPE':>8}")
print("-" * 101)
for r in results:
    print(f"{r['label']:<55} {r['mae']:>18,.2f} {r['rmse']:>18,.2f} {r['mape']:>7.2f}%")

tuned_result = results[2]
default_result = results[0]

print()
if tuned_result['rmse'] < default_result['rmse']:
    print(f"RESULT: Tuned model beats defaults on the test set "
          f"(RMSE {tuned_result['rmse']:,.2f} < {default_result['rmse']:,.2f}).")
else:
    print(f"RESULT: Tuned model does NOT beat defaults on the test set "
          f"(RMSE {tuned_result['rmse']:,.2f} >= {default_result['rmse']:,.2f}). "
          f"Keep defaults in ml/forecast_api.py.")
