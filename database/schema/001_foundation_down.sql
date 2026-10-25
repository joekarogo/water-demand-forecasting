-- Reverses 001_foundation.sql.
-- For development rollback only — NOT a safe production rollback: it does
-- not restore production_records or analytics_reports (001_foundation.sql
-- drops those; recreating them with their original, empty data is a no-op
-- anyway, but their rows — there were none — are not recoverable by this
-- script regardless).

BEGIN;

DROP TRIGGER IF EXISTS trg_audit_log_append_only_truncate ON audit_log;
DROP TRIGGER IF EXISTS trg_audit_log_append_only ON audit_log;
DROP FUNCTION IF EXISTS audit_log_prevent_modification();
DROP TABLE IF EXISTS audit_log;

DROP TABLE IF EXISTS stock_entries;
DROP TABLE IF EXISTS production_plans;

DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS water_balance;

DROP TABLE IF EXISTS tariff_type_map;
DROP TABLE IF EXISTS tariffs;

DROP TABLE IF EXISTS consumption_detail;

ALTER TABLE users
    DROP COLUMN IF EXISTS role_id,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS deactivated_at,
    DROP COLUMN IF EXISTS deactivation_reason,
    DROP COLUMN IF EXISTS auth_provider;

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;

COMMIT;
