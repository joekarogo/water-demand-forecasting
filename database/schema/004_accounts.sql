-- Module 1, Part 1: database changes for account management — Google
-- sign-in support, an emergency local-admin login, and invited-user
-- records — plus the login-attempt tracking the emergency-login lockout
-- rule needs (5 failures from one IP in 15 minutes -> blocked for 15
-- minutes).
--
-- users.role is intentionally left in place here — the current login
-- route and frontend still read it. It's dropped in Part 3, once nothing
-- reads it anymore.
--
-- Run manually (see database/schema/README.md). Wrapped in a single
-- transaction: either all of this applies, or none of it does.

BEGIN;

-- ---------------------------------------------------------------------------
-- a) users: nullable password (Google accounts have none), Google's
--    subject id, last login time, and a real CHECK on auth_provider
--    (the column has existed since 001_foundation.sql, but with no CHECK).
-- ---------------------------------------------------------------------------
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255) UNIQUE NULL,
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_provider_check;
ALTER TABLE users ADD CONSTRAINT users_auth_provider_check
    CHECK (auth_provider IN ('password', 'google', 'emergency'));

-- ---------------------------------------------------------------------------
-- b) Permissions: add data:view; Admin loses distribution:view/tariff:view/
--    revenue:view (plan:view was already removed in 003_production_planning.sql)
--    and gains data:view — Admin manages accounts and sees aggregate data,
--    not the day-to-day operational screens those three were meant for.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code) VALUES ('data:view') ON CONFLICT (code) DO NOTHING;

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.role_id
  AND rp.permission_id = p.permission_id
  AND r.name = 'admin'
  AND p.code IN ('distribution:view', 'tariff:view', 'revenue:view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
JOIN permissions p ON r.name = 'admin' AND p.code = 'data:view'
ON CONFLICT (role_id, permission_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- c) Login attempts, for the emergency-login lockout rule.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
    attempt_id BIGSERIAL PRIMARY KEY,
    ip_address VARCHAR(45) NOT NULL,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    succeeded BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time ON login_attempts (ip_address, attempted_at);

COMMIT;
