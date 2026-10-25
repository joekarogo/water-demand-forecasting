import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
import os
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

DETAIL_PATH = os.getenv("IZSU_DETAIL_PATH", r"C:\Users\HomePC\Documents\izsu_detail_monthly.csv")

df = pd.read_csv(DETAIL_PATH)
df['year_month'] = pd.to_datetime(df['year_month'])

conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT")
)
cursor = conn.cursor()

# One transaction: clear existing rows, insert all, commit. Re-running this
# script therefore replaces the data rather than duplicating it.
try:
    cursor.execute("DELETE FROM consumption_detail")
    insert_cols = ['year_month', 'district', 'customer_group', 'subscriber_type', 'subscribers', 'consumption_m3']
    # Convert NaN -> None before inserting, so psycopg2 sends SQL NULL
    # rather than a numeric NaN, if any value is missing.
    records_df = df[insert_cols].astype(object).where(df[insert_cols].notna(), None)
    records = records_df.values.tolist()
    execute_values(cursor, """
        INSERT INTO consumption_detail
            (year_month, district, customer_group, subscriber_type, subscribers, consumption_m3)
        VALUES %s
    """, records)
    conn.commit()
except Exception:
    conn.rollback()
    cursor.close()
    conn.close()
    raise

cursor.execute("SELECT COUNT(*) FROM consumption_detail")
print(f"Rows loaded: {cursor.fetchone()[0]}")

cursor.execute("""
    SELECT district, SUM(consumption_m3) AS total_consumption_m3
    FROM consumption_detail
    GROUP BY district
    ORDER BY total_consumption_m3 DESC
    LIMIT 3
""")
print("\nTop 3 districts by total consumption:")
for district, total in cursor.fetchall():
    print(f"  {district}: {total:,.0f} m3")

cursor.close()
conn.close()
