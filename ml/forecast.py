import pandas as pd
import psycopg2
from prophet import Prophet
from prophet.diagnostics import cross_validation, performance_metrics
from sklearn.metrics import mean_absolute_error, mean_squared_error
import numpy as np
import joblib
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

# Load consumption data from izsu_consumption (official IZSU billed data).
# consumption_cleaned_m3 has the 5 outlier months (2019-09 billing spike;
# 2020-04/05/06 COVID meter-reading suspension; 2020-08) interpolated.
query = "SELECT date, consumption_cleaned_m3 FROM izsu_consumption ORDER BY date"
df = pd.read_sql(query, conn)
conn.close()

# Prepare data for Prophet
df.columns = ['ds', 'y']
df['ds'] = pd.to_datetime(df['ds'])
df = df.sort_values('ds').reset_index(drop=True)

print(df.head())
print(df.tail())

print(f"Data loaded: {len(df)} records")
print(f"Date range: {df['ds'].min()} to {df['ds'].max()}")

# Train test split—80/20
split_index = int(len(df) * 0.8)
train = df[:split_index]
test = df[split_index:]

print(f"Training records: {len(train)}")
print(f"Testing records: {len(test)}")

# Train Prophet model
# Using Prophet's default hyperparameters for now. The previously tuned
# values (changepoint_prior_scale=0.01, seasonality_prior_scale=10,
# seasonality_mode='multiplicative') were fit on the synthetic Kaggle
# consumption column and do not apply to this real IZSU data. Proper
# retuning against izsu_consumption is pending (see ml/tune_prophet.py).
model = Prophet(
    yearly_seasonality=True,
    weekly_seasonality=False,
    daily_seasonality=False,
    changepoint_prior_scale=0.05,
    seasonality_prior_scale=10,
    seasonality_mode='additive'
)
model.fit(train)

# Generate forecast
future = model.make_future_dataframe(periods=len(test), freq='MS')
forecast = model.predict(future)

# Get predictions
predictions = forecast['yhat'].tail(len(test)).values
actuals = test['y'].values

# Calculate MAE, RMSE and MAPE
mae = mean_absolute_error(actuals, predictions)
rmse = np.sqrt(mean_squared_error(actuals, predictions))
mape = np.mean(np.abs((actuals - predictions) / actuals)) * 100

print(f"\nModel Evaluation:")
print(f"MAE: {mae:,.2f} m3")
print(f"RMSE: {rmse:,.2f} m3")
print(f"MAPE: {mape:,.2f}%")

# Seasonal-naive baseline: predict each test month by repeating the last 12
# training months in order (wrapping around if the horizon exceeds 12 months).
last_12_train = train['y'].values[-12:]
baseline_predictions = np.array([last_12_train[i % 12] for i in range(len(test))])

baseline_mae = mean_absolute_error(actuals, baseline_predictions)
baseline_rmse = np.sqrt(mean_squared_error(actuals, baseline_predictions))
baseline_mape = np.mean(np.abs((actuals - baseline_predictions) / actuals)) * 100

print(f"\nSeasonal-Naive Baseline:")
print(f"Baseline MAE: {baseline_mae:,.2f} m3")
print(f"Baseline RMSE: {baseline_rmse:,.2f} m3")
print(f"Baseline MAPE: {baseline_mape:,.2f}%")

# Cross validation — on the TRAINING data only (model was fit on `train`,
# and Prophet's cross_validation re-fits on rolling cutoffs drawn from that
# same history, so the test set is never touched here).
df_cv = cross_validation(model, initial='840 days', period='180 days', horizon='180 days')
df_metrics = performance_metrics(df_cv)

cv_mae = df_metrics['mae'].mean()
cv_rmse = df_metrics['rmse'].mean()
cv_mape = df_metrics['mape'].mean() * 100
cv_folds = df_cv['cutoff'].nunique()

print(f"\nCross Validation (training data only):")
print(f"CV Folds: {cv_folds}")
print(f"Mean MAE: {cv_mae:,.2f} m3")
print(f"Mean RMSE: {cv_rmse:,.2f} m3")
print(f"Mean MAPE: {cv_mape:,.2f}%")

# Retrain final model on all records
final_model = Prophet(
    yearly_seasonality=True,
    weekly_seasonality=False,
    daily_seasonality=False,
    changepoint_prior_scale=0.05,
    seasonality_prior_scale=10,
    seasonality_mode='additive'
)
final_model.fit(df)
print(f"\nFinal model retrained on all {len(df)} records")

# Save final model
model_path = r"G:\My Drive\water-demand-forecasting\models\prophet_model.pkl"
os.makedirs(os.path.dirname(model_path), exist_ok=True)
joblib.dump(final_model, model_path)
print(f"Final model saved to {model_path}")

# Generate future forecast
future_forecast = final_model.make_future_dataframe(periods=6, freq='MS')
future_predictions = final_model.predict(future_forecast)

print(f"\nForecast for next 6 months:")
future_only = future_predictions.tail(6)[['ds', 'yhat', 'yhat_lower', 'yhat_upper']]
print(future_only.to_string(index=False))
