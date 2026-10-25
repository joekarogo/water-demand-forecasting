"""
Publishes a 12-month forecast: computed once (after training), stored in
`forecasts` (kind='published') + `forecast_results`, and read instantly by
the website via GET /api/forecast/published — instead of being regenerated
on every request. Never deletes or overwrites earlier published forecasts;
each run is a new row.
"""

import os
import json
import joblib
import psycopg2
from psycopg2.extras import Json
import pandas as pd
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

DEFAULT_MODEL_PATH = r"G:\My Drive\water-demand-forecasting\models\prophet_model.pkl"
MODEL_PATH = os.getenv("MODEL_PATH", DEFAULT_MODEL_PATH)
METRICS_PATH = os.path.join(os.path.dirname(MODEL_PATH), 'model_metrics.json')
HORIZON = 12

if not os.path.exists(MODEL_PATH):
    raise SystemExit(f"ERROR: No trained model found at {MODEL_PATH}. Run ml/train_model.py first.")
if not os.path.exists(METRICS_PATH):
    raise SystemExit(f"ERROR: No metrics file found at {METRICS_PATH}. Run ml/train_model.py first.")

model = joblib.load(MODEL_PATH)
with open(METRICS_PATH) as f:
    saved_metrics = json.load(f)

conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT")
)
cursor = conn.cursor()

cursor.execute("SELECT MIN(date), MAX(date) FROM izsu_consumption")
data_min, data_max = cursor.fetchone()
data_up_to = data_max

# train_start/train_end: the saved model (ml/train_model.py's final_model)
# is trained on ALL of izsu_consumption, not just the train_size/test_size
# split recorded in model_metrics.json (that split is only used to compute
# the evaluation metrics). model_metrics.json doesn't currently record
# explicit train_start/train_end dates, so this falls back to the full
# izsu_consumption range — which is in fact the correct answer for what the
# saved model actually trained on, not just a stand-in.
train_start = saved_metrics.get('train_start', str(data_min))
train_end = saved_metrics.get('train_end', str(data_max))

model_name = saved_metrics.get('model_name', 'Prophet')
metrics = saved_metrics.get('prophet', {})
interval_width = model.interval_width

future = model.make_future_dataframe(periods=HORIZON, freq='MS')
forecast = model.predict(future)
forecast_only = forecast.tail(HORIZON)[['ds', 'yhat', 'yhat_lower', 'yhat_upper']]

try:
    cursor.execute(
        """
        INSERT INTO forecasts
            (user_id, generated_at, kind, horizon, model_name, mae, rmse, mape,
             data_up_to, train_start, train_end, interval_width)
        VALUES (NULL, NOW(), 'published', %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING forecast_id, generated_at
        """,
        (HORIZON, model_name, metrics.get('mae'), metrics.get('rmse'), metrics.get('mape'),
         data_up_to, train_start, train_end, interval_width)
    )
    forecast_id, published_at = cursor.fetchone()

    for row in forecast_only.itertuples():
        cursor.execute(
            """
            INSERT INTO forecast_results (forecast_id, date, predicted_value, yhat_lower, yhat_upper)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (forecast_id, row.ds.date(), float(row.yhat), float(row.yhat_lower), float(row.yhat_upper))
        )

    cursor.execute(
        """
        INSERT INTO audit_log (user_id, action, entity, entity_id, details)
        VALUES (NULL, 'forecast_published', 'forecasts', %s, %s)
        """,
        (str(forecast_id), Json({
            'horizon': HORIZON,
            'data_up_to': str(data_up_to),
            'model_name': model_name,
        }))
    )

    conn.commit()
except Exception:
    conn.rollback()
    cursor.close()
    conn.close()
    raise

cursor.close()
conn.close()

print(f"Published forecast_id {forecast_id} at {published_at}")
print(f"Data up to: {data_up_to}")
print("\n12-month forecast:")
for row in forecast_only.itertuples():
    print(f"  {row.ds.strftime('%Y-%m-%d')}: yhat={row.yhat:,.0f} "
          f"(lower={row.yhat_lower:,.0f}, upper={row.yhat_upper:,.0f})")
