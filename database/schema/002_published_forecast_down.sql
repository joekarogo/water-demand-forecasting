-- Reverses 002_published_forecast.sql. For development rollback only.

BEGIN;

DROP INDEX IF EXISTS idx_forecasts_kind_generated_at;

ALTER TABLE forecasts
    DROP COLUMN IF EXISTS kind,
    DROP COLUMN IF EXISTS data_up_to,
    DROP COLUMN IF EXISTS train_start,
    DROP COLUMN IF EXISTS train_end,
    DROP COLUMN IF EXISTS interval_width;

COMMIT;
