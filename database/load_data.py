import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

df_raw = pd.read_csv(r'C:\Users\HomePC\Documents\Izmir dataset.csv')
print(df_raw['Tarih'].head(10))
print(df_raw['Tarih'].dtype)

# DB connection
conn = psycopg2.connect(
    host="localhost",
    database="water_forecasting_db",
    user="postgres",
    password="4407",
    port="5432"
)

cursor = conn.cursor()

# Read CSV
df = pd.read_csv(r'C:\Users\HomePC\Documents\Izmir dataset.csv')

# Rename relevant columns
df = df[['Tarih', 'Su_Tuketim_Aylik_m3', 'URETIM_MIKTARI']]
df['Tarih'] = pd.to_datetime(df['Tarih'], format='%m/%d/%Y')
df.columns = ['date', 'consumption_m3', 'production_m3']

# Convert date
df['date'] = pd.to_datetime(df['date'], dayfirst=True)

# Insert into DB
records = df.values.tolist()
execute_values(cursor, """
    INSERT INTO consumption_data (date, consumption_m3, production_m3)
    VALUES %s
""", records)

conn.commit()
cursor.close()
conn.close()

print("Data loaded successfully!")