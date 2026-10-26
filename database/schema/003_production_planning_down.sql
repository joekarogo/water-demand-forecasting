-- Reverses 003_production_planning.sql. For development rollback only —
-- NOT a safe production rollback: it can't undo the stock_m3 > 0 check
-- having rejected any 0-valued inserts that happened while it was active,
-- and it restores Admin's plan:view permission unconditionally (harmless,
-- but not necessarily what you want if it was removed on purpose).

BEGIN;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM roles r
JOIN permissions p ON p.code = 'plan:view'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

ALTER TABLE stock_entries DROP CONSTRAINT IF EXISTS stock_entries_stock_m3_check;
ALTER TABLE stock_entries ADD CONSTRAINT stock_entries_stock_m3_check CHECK (stock_m3 >= 0);

DROP INDEX IF EXISTS idx_production_plans_forecast_month_version;
DROP INDEX IF EXISTS idx_production_plans_one_active;

ALTER TABLE production_plans
    DROP CONSTRAINT IF EXISTS production_plans_custom_requires_reason_note,
    DROP COLUMN IF EXISTS is_active,
    DROP COLUMN IF EXISTS version,
    DROP COLUMN IF EXISTS reason,
    DROP COLUMN IF EXISTS chosen_m3,
    DROP COLUMN IF EXISTS plan_type,
    ALTER COLUMN forecast_id DROP NOT NULL;

COMMIT;
