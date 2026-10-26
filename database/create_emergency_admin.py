"""
Creates or updates the single emergency local-admin account — a
password-based fallback login that doesn't depend on Google OAuth being
reachable. Reads EMERGENCY_ADMIN_EMAIL / EMERGENCY_ADMIN_PASSWORD from
.env. Never prints the password: it only ever becomes a bcrypt hash.

Run manually: python database/create_emergency_admin.py
Requires database/schema/001_foundation.sql (roles) and
database/schema/004_accounts.sql (nullable password, auth_provider check)
to have been run first.
"""

import os
import sys
import bcrypt
import psycopg2
from psycopg2.extras import Json
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

MIN_PASSWORD_LENGTH = 16
EMERGENCY_ADMIN_NAME = 'Emergency Admin'

email = os.getenv("EMERGENCY_ADMIN_EMAIL")
password = os.getenv("EMERGENCY_ADMIN_PASSWORD")

if not email or not password:
    sys.exit(
        "ERROR: EMERGENCY_ADMIN_EMAIL and EMERGENCY_ADMIN_PASSWORD must both be set "
        "in the project root .env file before running this script."
    )

if len(password) < MIN_PASSWORD_LENGTH:
    sys.exit(f"ERROR: EMERGENCY_ADMIN_PASSWORD must be at least {MIN_PASSWORD_LENGTH} characters.")

email = email.strip().lower()

conn = psycopg2.connect(
    host=os.getenv("DB_HOST"),
    database=os.getenv("DB_NAME"),
    user=os.getenv("DB_USER"),
    password=os.getenv("DB_PASSWORD"),
    port=os.getenv("DB_PORT"),
)
cursor = conn.cursor()

cursor.execute("SELECT role_id FROM roles WHERE name = 'admin'")
row = cursor.fetchone()
if not row:
    cursor.close()
    conn.close()
    sys.exit("ERROR: no 'admin' role found. Run database/schema/001_foundation.sql first.")
admin_role_id = row[0]

# Case-insensitive: an email stored with different casing elsewhere in the
# system must still be recognized as the same account.
cursor.execute("SELECT user_id, auth_provider FROM users WHERE lower(email) = %s", (email,))
existing = cursor.fetchone()

if existing and existing[1] != 'emergency':
    cursor.close()
    conn.close()
    sys.exit(
        f"ERROR: {email} belongs to an existing non-emergency account. "
        "Use a separate email for the emergency admin."
    )

if not existing:
    # Only one emergency admin is allowed. If `existing` is None, any
    # emergency-provider row found here is necessarily a different email
    # (otherwise the lower(email) lookup above would have matched it).
    cursor.execute("SELECT email FROM users WHERE auth_provider = 'emergency' LIMIT 1")
    other_row = cursor.fetchone()
    if other_row:
        cursor.close()
        conn.close()
        sys.exit(
            f"ERROR: an emergency admin already exists ({other_row[0]}). Only one is allowed; "
            "set EMERGENCY_ADMIN_EMAIL to that address to rotate its password."
        )

password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

try:
    if existing:
        user_id = existing[0]
        # name is deliberately left alone here: rotating the emergency
        # password shouldn't also rename the account.
        cursor.execute(
            """
            UPDATE users
            SET password = %s, role = 'admin', role_id = %s, status = 'active', auth_provider = 'emergency'
            WHERE user_id = %s
            """,
            (password_hash, admin_role_id, user_id)
        )
    else:
        cursor.execute(
            """
            INSERT INTO users (name, email, password, role, role_id, status, auth_provider)
            VALUES (%s, %s, %s, 'admin', %s, 'active', 'emergency')
            RETURNING user_id
            """,
            (EMERGENCY_ADMIN_NAME, email, password_hash, admin_role_id)
        )
        user_id = cursor.fetchone()[0]

    cursor.execute(
        """
        INSERT INTO audit_log (user_id, action, entity, entity_id, details)
        VALUES (NULL, 'emergency_admin.set', 'users', %s, %s)
        """,
        (str(user_id), Json({'email': email}))
    )

    conn.commit()
except Exception:
    conn.rollback()
    raise
finally:
    cursor.close()
    conn.close()

print(f"Emergency admin account ready: {email} (user_id={user_id})")
