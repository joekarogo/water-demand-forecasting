# DEPRECATED: uses the old synthetic Kaggle data (consumption_data). Not used by the current model. To be updated to izsu_consumption.
import pandas as pd
import psycopg2
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

# Load consumption data
query = "SELECT date, consumption_m3 FROM consumption_data ORDER BY date"
df = pd.read_sql(query, conn)
conn.close()

# Prepare data
df.columns = ['ds', 'y']
df['ds'] = pd.to_datetime(df['ds'])
df = df.sort_values('ds').reset_index(drop=True)

print(df.head())
print(df.tail())

print(f"Data loaded: {len(df)} records")
print(f"Date range: {df['ds'].min()} to {df['ds'].max()}")
