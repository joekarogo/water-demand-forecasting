import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
import os
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

# DB connection
conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT")
)
cursor = conn.cursor()

# Create table if it doesn't exist yet (see database/create_izsu_consumption.sql)
cursor.execute("""
    CREATE TABLE IF NOT EXISTS izsu_consumption (
        date DATE PRIMARY KEY,
        consumption_m3 BIGINT,
        consumption_cleaned_m3 BIGINT,
        is_outlier VARCHAR(3),
        subscribers INTEGER
    )
""")

# Read CSV — official IZSU monthly consumption data
csv_path = r"C:\Users\HomePC\Documents\izsu_monthly_consumption.csv"
df = pd.read_csv(csv_path)
df['date'] = pd.to_datetime(df['date'])

print(df.head())
print(df.tail())
print(f"Rows in CSV: {len(df)}")

# Clear existing records before reload (safe to re-run)
cursor.execute("DELETE FROM izsu_consumption")

records = df[['date', 'consumption_m3', 'consumption_cleaned_m3', 'is_outlier', 'subscribers']].values.tolist()
execute_values(cursor, """
    INSERT INTO izsu_consumption (date, consumption_m3, consumption_cleaned_m3, is_outlier, subscribers)
    VALUES %s
""", records)

conn.commit()

# Confirm row count
cursor.execute("SELECT COUNT(*) FROM izsu_consumption")
count = cursor.fetchone()[0]
print(f"\nRows loaded into izsu_consumption: {count}")

cursor.close()
conn.close()

print("izsu_consumption loaded successfully!")
