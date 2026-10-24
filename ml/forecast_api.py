import pandas as pd
import psycopg2
import joblib
import json
import os
import sys
import warnings
from dotenv import load_dotenv
warnings.filterwarnings('ignore')

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

DEFAULT_MODEL_PATH = r"G:\My Drive\water-demand-forecasting\models\prophet_model.pkl"
MODEL_PATH = os.getenv("MODEL_PATH", DEFAULT_MODEL_PATH)
METRICS_PATH = os.path.join(os.path.dirname(MODEL_PATH), 'model_metrics.json')

VALID_HORIZONS = (3, 6, 12)

# Horizon is passed as a CLI argument by backend/index.js; default to 6 if run
# directly with no argument. All diagnostic output below goes to stderr, so
# stdout carries nothing but the final JSON result.
horizon = 6
if len(sys.argv) > 1:
    try:
        horizon = int(sys.argv[1])
    except ValueError:
        print(f"ERROR: Invalid horizon argument {sys.argv[1]!r}. Must be 3, 6, or 12.", file=sys.stderr)
        sys.exit(1)

if horizon not in VALID_HORIZONS:
    print(f"ERROR: Invalid horizon {horizon}. Must be 3, 6, or 12.", file=sys.stderr)
    sys.exit(1)

if not os.path.exists(MODEL_PATH):
    print(f"ERROR: No trained model found at {MODEL_PATH}. Run ml/train_model.py first.", file=sys.stderr)
    sys.exit(1)

if not os.path.exists(METRICS_PATH):
    print(f"ERROR: No metrics file found at {METRICS_PATH}. Run ml/train_model.py first.", file=sys.stderr)
    sys.exit(1)

model = joblib.load(MODEL_PATH)

with open(METRICS_PATH) as f:
    saved_metrics = json.load(f)

# Full history (for the chart to show past + future)
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

future = model.make_future_dataframe(periods=horizon, freq='MS')
forecast = model.predict(future)
forecast_only = forecast.tail(horizon)[['ds', 'yhat', 'yhat_lower', 'yhat_upper']]

# The model's fitted value at the last historical date (not a real future
# prediction) — used only so the chart's forecast line can start exactly
# where the actual-consumption line ends, with no visual gap between them.
connector_row = forecast.iloc[-(horizon + 1)]

output = {
    'model_name': saved_metrics.get('model_name', 'Prophet'),
    'horizon': horizon,
    'metrics': saved_metrics.get('prophet', {}),
    'baselines': {
        'seasonal_naive': saved_metrics.get('seasonal_naive', {}),
        'last_year_growth': saved_metrics.get('last_year_growth', {}),
    },
    'interval_width': model.interval_width,
    'history': [
        {'date': row.ds.strftime('%Y-%m-%d'), 'actual': float(row.y)}
        for row in df.itertuples()
    ],
    'connector': {
        'date': connector_row['ds'].strftime('%Y-%m-%d'),
        'yhat': float(connector_row['yhat']),
        'yhat_lower': float(connector_row['yhat_lower']),
        'yhat_upper': float(connector_row['yhat_upper']),
    },
    'forecast': [
        {
            'date': row.ds.strftime('%Y-%m-%d'),
            'yhat': float(row.yhat),
            'yhat_lower': float(row.yhat_lower),
            'yhat_upper': float(row.yhat_upper),
        }
        for row in forecast_only.itertuples()
    ],
}

print(json.dumps(output))
