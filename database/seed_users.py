import os
import bcrypt
import psycopg2
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

users = [
    {
        'name': 'Water Manager',
        'email': 'manager@water.com',
        'password': 'kenya1234',
        'role': 'manager'
    },
    {
        'name': 'System Admin',
        'email': 'admin@water.com',
        'password': 'kenya12345',
        'role': 'admin'
    }
]

for user in users:
    hashed_password = bcrypt.hashpw(user['password'].encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    cursor.execute("""
        INSERT INTO users (name, email, password, role)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (email) DO NOTHING
    """, (user['name'], user['email'], hashed_password, user['role']))
    print(f"Seeded user: {user['email']} ({user['role']})")

conn.commit()
cursor.close()
conn.close()

print("User seeding complete!")
