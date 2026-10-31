-- Module 1, Part 2A: server-side sessions for Google sign-in and the
-- emergency local-admin login. The raw session id is never stored here —
-- only its SHA-256 hash (session_id_hash) — so a stolen copy of this
-- table alone can't be used to impersonate a signed-in user; the matching
-- raw id would also be needed (it only ever lives in the browser's
-- HttpOnly `sid` cookie).
--
-- Run manually (see database/schema/README.md). Wrapped in a single
-- transaction: either all of this applies, or none of it does.

BEGIN;

CREATE TABLE IF NOT EXISTS sessions (
    session_id_hash CHAR(64) PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(user_id),
    csrf_token CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    ip_address VARCHAR(45)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

COMMIT;
