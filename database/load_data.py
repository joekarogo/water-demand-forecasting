import pandas as pd
import psycopg2
import os
from psycopg2.extras import execute_values
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

df_raw = pd.read_csv(r'C:\Users\HomePC\Documents\Izmir dataset.csv')
print(df_raw['Tarih'].head(10))
print(df_raw['Tarih'].dtype)

# DB connection
conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT")
)

cursor = conn.cursor()

# Read CSV
df = pd.read_csv(r'C:\Users\HomePC\Documents\Izmir dataset.csv')

# Rename relevant columns
df = df[['Tarih', 'Su_Tuketim_Aylik_m3', 'URETIM_MIKTARI', 'Sicaklik_Ort', 'Yagis_mm', 'Nufus']]
df['Tarih'] = pd.to_datetime(df['Tarih'], format='%m/%d/%Y')
df.columns = ['date', 'consumption_m3', 'production_m3', 'temperature', 'precipitation', 'population']

# Convert date
df['date'] = pd.to_datetime(df['date'], dayfirst=True)

# Clear existing records before reload
cursor.execute("DELETE FROM consumption_data")

# Insert into DB
records = df.values.tolist()
execute_values(cursor, """
    INSERT INTO consumption_data (date, consumption_m3, production_m3, temperature, precipitation, population)
    VALUES %s
""", records)

conn.commit()
cursor.close()
conn.close()

print("Data loaded successfully!")
