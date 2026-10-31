-- Reverses 009_timestamptz.sql. For development rollback only: converts
-- forecasts.generated_at and users.created_at back to TIMESTAMP WITHOUT
-- TIME ZONE, re-deriving the Nairobi wall-clock value from the stored
-- instant with `AT TIME ZONE 'Africa/Nairobi'` (the exact inverse of the
-- up migration's conversion).
--
-- Safe to re-run: each column is only converted if it is still
-- TIMESTAMPTZ.

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'forecasts'
          AND column_name = 'generated_at' AND data_type = 'timestamp with time zone'
    ) THEN
        EXECUTE 'ALTER TABLE forecasts ALTER COLUMN generated_at TYPE TIMESTAMP WITHOUT TIME ZONE USING generated_at AT TIME ZONE ''Africa/Nairobi''';
        EXECUTE 'ALTER TABLE forecasts ALTER COLUMN generated_at SET DEFAULT CURRENT_TIMESTAMP';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = 'created_at' AND data_type = 'timestamp with time zone'
    ) THEN
        EXECUTE 'ALTER TABLE users ALTER COLUMN created_at TYPE TIMESTAMP WITHOUT TIME ZONE USING created_at AT TIME ZONE ''Africa/Nairobi''';
        EXECUTE 'ALTER TABLE users ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP';
    END IF;
END $$;

COMMIT;
