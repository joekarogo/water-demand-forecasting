# DEPRECATED: replaced by database/create_emergency_admin.py (the
# emergency local-admin login) and database/invite_user.py (Google-sign-in
# invites) in Module 1, Part 3. Kept only so databases that still have
# these two password-based test accounts keep working; do not use this
# for new setups.

import os
import sys
import bcrypt
import psycopg2
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

manager_password = os.getenv("SEED_MANAGER_PASSWORD")
admin_password = os.getenv("SEED_ADMIN_PASSWORD")

if not manager_password or not admin_password:
    sys.exit(
        "ERROR: SEED_MANAGER_PASSWORD and SEED_ADMIN_PASSWORD must both be set "
        "in the project root .env file before running this script."
    )

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
        'password': manager_password,
        'role': 'manager'
    },
    {
        'name': 'System Admin',
        'email': 'admin@water.com',
        'password': admin_password,
        'role': 'admin'
    }
]

for user in users:
    hashed_password = bcrypt.hashpw(user['password'].encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    cursor.execute("""
        INSERT INTO users (name, email, password, role)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (email) DO UPDATE
        SET password = EXCLUDED.password,
            role = EXCLUDED.role,
            name = EXCLUDED.name
    """, (user['name'], user['email'], hashed_password, user['role']))
    print(f"Seeded user: {user['email']} ({user['role']})")

conn.commit()
cursor.close()
conn.close()

print("User seeding complete!")
