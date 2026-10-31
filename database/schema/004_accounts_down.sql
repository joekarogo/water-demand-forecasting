-- Reverses 004_accounts.sql. For development rollback only — NOT a safe
-- production rollback: it does not restore users.password's NOT NULL
-- (any row inserted with a NULL password while this migration was active
-- would violate that), and any login_attempts history is simply dropped.

BEGIN;

DROP INDEX IF EXISTS idx_login_attempts_ip_time;
DROP TABLE IF EXISTS login_attempts;

DELETE FROM role_permissions
WHERE permission_id = (SELECT permission_id FROM permissions WHERE code = 'data:view');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
JOIN permissions p ON r.name = 'admin' AND p.code IN ('distribution:view', 'tariff:view', 'revenue:view')
ON CONFLICT (role_id, permission_id) DO NOTHING;

DELETE FROM permissions WHERE code = 'data:view';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_auth_provider_check;

ALTER TABLE users
    DROP COLUMN IF EXISTS last_login_at,
    DROP COLUMN IF EXISTS google_sub;

COMMIT;
