-- Module 1, Part 3A: removes the password login (POST /api/auth/login is
-- deleted in this same part) and, with it, the last reader of users.role —
-- every route now reads a user's role via users.role_id -> roles.name
-- instead.
--
-- Run manually (see database/schema/README.md), after 005_sessions.sql.
-- Wrapped in a single transaction: either all of this applies, or none of
-- it does.

BEGIN;

-- ---------------------------------------------------------------------------
-- a) Deactivate every remaining password-based account rather than delete
--    it (keeps the row for history/audit). One audit_log row per account;
--    user_id is NULL because this is a migration action, not something a
--    particular signed-in user did.
-- ---------------------------------------------------------------------------
WITH deactivated AS (
    UPDATE users
    SET status = 'deactivated',
        deactivated_at = now(),
        deactivation_reason = 'Password login removed; replaced by Google sign-in'
    WHERE auth_provider = 'password'
    RETURNING user_id
)
INSERT INTO audit_log (user_id, action, entity, entity_id, details)
SELECT NULL, 'user.deactivated', 'users', user_id::text,
       jsonb_build_object('reason', 'Password login removed; replaced by Google sign-in')
FROM deactivated;

-- ---------------------------------------------------------------------------
-- b) A deactivated account shouldn't keep using a session it already had.
-- ---------------------------------------------------------------------------
DELETE FROM sessions
WHERE user_id IN (SELECT user_id FROM users WHERE auth_provider = 'password');

-- ---------------------------------------------------------------------------
-- c) users.role is no longer read anywhere.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP COLUMN IF EXISTS role;

COMMIT;
