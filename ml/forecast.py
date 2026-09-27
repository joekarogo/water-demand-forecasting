import pandas as pd
import psycopg2
from prophet import Prophet
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

# Retrain final model on all records
final_model = Prophet(
    yearly_seasonality=True,
    weekly_seasonality=False,
    daily_seasonality=False
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