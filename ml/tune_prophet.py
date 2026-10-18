import pandas as pd
import psycopg2
from prophet import Prophet
from prophet.diagnostics import cross_validation, performance_metrics
import itertools
import json
import os
import time
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

# Load consumption data
query = "SELECT date, consumption_m3 FROM consumption_data ORDER BY date"
df = pd.read_sql(query, conn)
conn.close()

# Prepare data for Prophet
df.columns = ['ds', 'y']
df['ds'] = pd.to_datetime(df['ds'])
df = df.sort_values('ds').reset_index(drop=True)

print(f"Data loaded: {len(df)} records", flush=True)

# Train test split—80/20 (same split used by forecast.py, so results are comparable)
split_index = int(len(df) * 0.8)
train = df[:split_index]
test = df[split_index:]

print(f"Training records: {len(train)}", flush=True)
print(f"Testing records: {len(test)}", flush=True)

# Grid search space
param_grid = {
    'changepoint_prior_scale': [0.01, 0.05, 0.1, 0.5],
    'seasonality_prior_scale': [1, 5, 10],
    'seasonality_mode': ['additive', 'multiplicative'],
}

all_params = [
    dict(zip(param_grid.keys(), values))
    for values in itertools.product(*param_grid.values())
]

print(f"\nRunning grid search over {len(all_params)} combinations "
      f"(initial=840 days, period=180 days, horizon=180 days each)...", flush=True)

results = []
start_time = time.time()

for i, params in enumerate(all_params):
    combo_start = time.time()
    print(f"\n[{i + 1}/{len(all_params)}] changepoint_prior_scale={params['changepoint_prior_scale']}, "
          f"seasonality_prior_scale={params['seasonality_prior_scale']}, "
          f"seasonality_mode={params['seasonality_mode']}", flush=True)

    model = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=False,
        daily_seasonality=False,
        changepoint_prior_scale=params['changepoint_prior_scale'],
        seasonality_prior_scale=params['seasonality_prior_scale'],
        seasonality_mode=params['seasonality_mode'],
    )
    model.fit(train)

    df_cv = cross_validation(model, initial='840 days', period='180 days', horizon='180 days')
    df_metrics = performance_metrics(df_cv)

    mean_rmse = df_metrics['rmse'].mean()
    mean_mae = df_metrics['mae'].mean()

    results.append({
        'changepoint_prior_scale': params['changepoint_prior_scale'],
        'seasonality_prior_scale': params['seasonality_prior_scale'],
        'seasonality_mode': params['seasonality_mode'],
        'mean_rmse': mean_rmse,
        'mean_mae': mean_mae,
        'cv_folds': df_cv['cutoff'].nunique(),
    })

    elapsed = time.time() - combo_start
    print(f"  -> Mean RMSE: {mean_rmse:,.2f} m3 | Mean MAE: {mean_mae:,.2f} m3 "
          f"({elapsed:.1f}s)", flush=True)

total_elapsed = time.time() - start_time
print(f"\nGrid search complete in {total_elapsed / 60:.1f} minutes", flush=True)

# Rank results best to worst by mean RMSE
results_sorted = sorted(results, key=lambda r: r['mean_rmse'])

print("\n=== Grid Search Results (ranked best to worst by Mean RMSE) ===", flush=True)
for rank, r in enumerate(results_sorted, 1):
    print(f"{rank}. changepoint_prior_scale={r['changepoint_prior_scale']}, "
          f"seasonality_prior_scale={r['seasonality_prior_scale']}, "
          f"seasonality_mode={r['seasonality_mode']} "
          f"-> Mean RMSE: {r['mean_rmse']:,.2f} m3, Mean MAE: {r['mean_mae']:,.2f} m3", flush=True)

# Save the full ranked results alongside best_params.json, so nothing from
# this ~2+ hour run is lost once the console output scrolls away
results_path = os.path.join(os.path.dirname(__file__), 'tuning_results.json')
with open(results_path, 'w') as f:
    json.dump(results_sorted, f, indent=2)
print(f"\nFull ranked results saved to {results_path}", flush=True)

# Save best parameters
best = results_sorted[0]
best_params_path = os.path.join(os.path.dirname(__file__), 'best_params.json')
with open(best_params_path, 'w') as f:
    json.dump(best, f, indent=2)

print(f"Best parameters saved to {best_params_path}", flush=True)
print(f"Best: {best}", flush=True)
