"""
Invites a new user: a status='invited', auth_provider='google' row with
no password. They get full access once they sign in with Google for the
first time (added in a later part of this module). Refuses if the email
already exists. Writes an audit_log row (action 'user.invited').

Run manually, e.g.:
    python database/invite_user.py --name "Jane Doe" --email jane@example.com --role production_manager
"""

import argparse
import os
import sys
import psycopg2
from psycopg2.extras import Json
from dotenv import load_dotenv

# Load environment variables from .env in the project root
dotenv_path = os.path.join(os.path.dirname(__file__), '..', '.env')
load_dotenv(dotenv_path)

ROLE_NAMES = ['admin', 'production_manager', 'commercial_officer']


def parse_args():
    parser = argparse.ArgumentParser(description='Invite a new user (Google sign-in, no password).')
    parser.add_argument('--name', required=True, help="The user's full name.")
    parser.add_argument('--email', required=True, help="The user's email address.")
    parser.add_argument('--role', required=True, choices=sorted(ROLE_NAMES), help='Role to assign.')
    return parser.parse_args()


def main():
    args = parse_args()
    name = args.name.strip()
    email = args.email.strip().lower()
    role_name = args.role

    if not name:
        sys.exit("ERROR: --name must not be empty.")
    if not email:
        sys.exit("ERROR: --email must not be empty.")

    conn = psycopg2.connect(
        host=os.getenv("DB_HOST"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD"),
        port=os.getenv("DB_PORT"),
    )
    cursor = conn.cursor()

    # Case-insensitive: an email stored with different casing elsewhere in
    # the system must still be recognized as the same account.
    cursor.execute("SELECT 1 FROM users WHERE lower(email) = %s", (email,))
    if cursor.fetchone():
        cursor.close()
        conn.close()
        sys.exit(f"ERROR: a user with email {email} already exists.")

    cursor.execute("SELECT role_id FROM roles WHERE name = %s", (role_name,))
    row = cursor.fetchone()
    if not row:
        cursor.close()
        conn.close()
        sys.exit(f"ERROR: no role named '{role_name}' found. Run database/schema/001_foundation.sql first.")
    role_id = row[0]

    try:
        cursor.execute(
            """
            INSERT INTO users (name, email, password, role_id, status, auth_provider)
            VALUES (%s, %s, NULL, %s, 'invited', 'google')
            RETURNING user_id
            """,
            (name, email, role_id)
        )
        user_id = cursor.fetchone()[0]

        cursor.execute(
            """
            INSERT INTO audit_log (user_id, action, entity, entity_id, details)
            VALUES (NULL, 'user.invited', 'users', %s, %s)
            """,
            (str(user_id), Json({'email': email, 'role': role_name}))
        )

        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cursor.close()
        conn.close()

    print(f"Invited {email} as {role_name} (user_id={user_id}).")


if __name__ == '__main__':
    main()
