-- Reverses 006_remove_password_login.sql. For development rollback only —
-- NOT a safe production rollback: users.role comes back NULL for
-- everyone (the original values are gone), and any sessions deleted by
-- the up migration cannot be restored (those users just sign in again).
-- Only accounts deactivated BY THIS MIGRATION (matched by the exact
-- deactivation_reason it used) are reactivated — an account some admin
-- separately deactivated for a different reason is left alone.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20);

UPDATE users
SET status = 'active', deactivated_at = NULL, deactivation_reason = NULL
WHERE auth_provider = 'password'
  AND deactivation_reason = 'Password login removed; replaced by Google sign-in';

DELETE FROM audit_log
WHERE action = 'user.deactivated'
  AND details->>'reason' = 'Password login removed; replaced by Google sign-in';

COMMIT;
