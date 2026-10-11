import pandas as pd
import psycopg2
from prophet import Prophet
from sklearn.metrics import mean_absolute_error, mean_squared_error
import numpy as np
import os
from dotenv import load_dotenv

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

# Load consumption data with regressor columns
query = """
    SELECT date, consumption_m3, temperature, precipitation, population
    FROM consumption_data
    ORDER BY date
"""
df = pd.read_sql(query, conn)
conn.close()

print(df.head())

# Rename columns for Prophet
df = df.rename(columns={'date': 'ds', 'consumption_m3': 'y'})

# Train test split—80/20, preserving temporal order
split_index = int(len(df) * 0.8)
train = df[:split_index]
test = df[split_index:]

print(f"Training records: {len(train)}")
print(f"Testing records: {len(test)}")

# Train Prophet model with regressors
model = Prophet(
    yearly_seasonality=True,
    weekly_seasonality=False,
    daily_seasonality=False
)
model.add_regressor('temperature')
model.add_regressor('precipitation')
model.add_regressor('population')
model.fit(train)

# Generate forecast for the test period using actual future regressor values
future = test[['ds', 'temperature', 'precipitation', 'population']]
forecast = model.predict(future)

# Get predictions
predictions = forecast['yhat'].values
actuals = test['y'].values

# Calculate MAE, RMSE and MAPE
mae = mean_absolute_error(actuals, predictions)
rmse = np.sqrt(mean_squared_error(actuals, predictions))
mape = np.mean(np.abs((actuals - predictions) / actuals)) * 100

print(f"\nModel Evaluation (with regressors):")
print(f"MAE: {mae:,.2f} m3")
print(f"RMSE: {rmse:,.2f} m3")
print(f"MAPE: {mape:,.2f}%")

# Compare with baseline Prophet model
baseline_mae = 401104
baseline_rmse = 457897

print(f"\nComparison with baseline Prophet model:")
print(f"Baseline MAE: {baseline_mae:,.2f} m3 | With regressors MAE: {mae:,.2f} m3 | Change: {mae - baseline_mae:,.2f} m3 ({(mae - baseline_mae) / baseline_mae * 100:,.2f}%)")
print(f"Baseline RMSE: {baseline_rmse:,.2f} m3 | With regressors RMSE: {rmse:,.2f} m3 | Change: {rmse - baseline_rmse:,.2f} m3 ({(rmse - baseline_rmse) / baseline_rmse * 100:,.2f}%)")
