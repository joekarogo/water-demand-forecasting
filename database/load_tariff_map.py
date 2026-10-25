import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
import os
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

MAP_PATH = os.path.join(os.path.dirname(__file__), 'tariff_type_map.csv')

df = pd.read_csv(MAP_PATH)

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
    cursor.execute("DELETE FROM tariff_type_map")
    insert_cols = ['consumption_type', 'tariff_type', 'is_assumption', 'note']
    # Empty tariff_type ('') -> NULL, and NaN -> None generally, so psycopg2
    # sends SQL NULL rather than an empty string or numeric NaN.
    records_df = df[insert_cols].replace('', None)
    records_df = records_df.astype(object).where(records_df.notna(), None)
    records = records_df.values.tolist()
    execute_values(cursor, """
        INSERT INTO tariff_type_map (consumption_type, tariff_type, is_assumption, note)
        VALUES %s
    """, records)
    conn.commit()
except Exception:
    conn.rollback()
    cursor.close()
    conn.close()
    raise

cursor.execute("SELECT COUNT(*) FROM tariff_type_map")
print(f"Rows loaded: {cursor.fetchone()[0]}")

cursor.close()
conn.close()
