import pandas as pd
import psycopg2
from prophet import Prophet
from sklearn.metrics import mean_absolute_error, mean_squared_error
import numpy as np
import warnings
warnings.filterwarnings('ignore')

# Connect to database
conn = psycopg2.connect(
    host="localhost",
    database="water_forecasting_db",
    user="postgres",
    password="4407",
    port="5432"
)

# Load consumption data
query = "SELECT date, consumption_m3 FROM consumption_data ORDER BY date"
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
model = Prophet(
    yearly_seasonality=True,
    weekly_seasonality=False,
    daily_seasonality=False
)
model.fit(train)

# Generate forecast
future = model.make_future_dataframe(periods=len(test), freq='MS')
forecast = model.predict(future)

# Get predictions
predictions = forecast['yhat'].tail(len(test)).values
actuals = test['y'].values

# Calculate MAE and RMSE
mae = mean_absolute_error(actuals, predictions)
rmse = np.sqrt(mean_squared_error(actuals, predictions))

print(f"\nModel Evaluation:")
print(f"MAE: {mae:,.2f} m3")
print(f"RMSE: {rmse:,.2f} m3")

# Generate future forecast
future_forecast = model.make_future_dataframe(periods=6, freq='MS')
future_predictions = model.predict(future_forecast)

print(f"\nForecast for next 6 months:")
future_only = future_predictions.tail(6)[['ds', 'yhat', 'yhat_lower', 'yhat_upper']]
print(future_only.to_string(index=False))