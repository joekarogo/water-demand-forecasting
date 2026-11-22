-- Reverses 010_stock_reading_versions.sql. For development rollback only
-- — NOT a safe production rollback: it can't restore which rows were
-- state = 'active' vs 'replaced'/'removed' once the columns are dropped
-- (every surviving row just looks like a plain, never-corrected reading
-- again), and it removes the storage_capacity_m3 setting unconditionally
-- even if something else came to depend on it.

BEGIN;

DELETE FROM settings WHERE key = 'storage_capacity_m3';

DROP INDEX IF EXISTS idx_stock_entries_one_active_per_date;

ALTER TABLE stock_entries
    DROP CONSTRAINT IF EXISTS stock_entries_state_requires_reason,
    DROP COLUMN IF EXISTS changed_at,
    DROP COLUMN IF EXISTS changed_by,
    DROP COLUMN IF EXISTS change_reason,
    DROP COLUMN IF EXISTS state;

COMMIT;
