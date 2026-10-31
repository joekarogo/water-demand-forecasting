-- Bug fix (found on the live Heroku deployment): forecasts.generated_at
-- and users.created_at were left as TIMESTAMP WITHOUT TIME ZONE in
-- 000_existing_schema.sql -- the one pair of timestamp columns in this
-- schema that never got converted when every other time column became
-- TIMESTAMPTZ. Both were written as Nairobi wall-clock time (the laptop
-- the app ran on locally); Heroku's dyno runs in UTC, so reading those
-- same naive values back there silently applies the wrong offset (a
-- forecast actually published 25 Oct 23:26 Nairobi time showed as 26 Oct).
--
-- The existing stored values -- on both the local database and the
-- Heroku database -- are Nairobi wall-clock times, so `AT TIME ZONE
-- 'Africa/Nairobi'` is the correct conversion in both places: it tells
-- Postgres "interpret this naive value as Nairobi time" and produces the
-- correct absolute instant, stored from then on as a real TIMESTAMPTZ.
--
-- Safe to re-run: each column is only converted if it is still
-- "timestamp without time zone" (checked against information_schema
-- first), so running this twice -- e.g. once locally, once on Heroku --
-- is a no-op the second time on whichever database already has it.
--
-- Run manually (see database/schema/README.md). Wrapped in a single
-- transaction: either all of this applies, or none of it does.

BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'forecasts'
          AND column_name = 'generated_at' AND data_type = 'timestamp without time zone'
    ) THEN
        EXECUTE 'ALTER TABLE forecasts ALTER COLUMN generated_at TYPE TIMESTAMPTZ USING generated_at AT TIME ZONE ''Africa/Nairobi''';
        EXECUTE 'ALTER TABLE forecasts ALTER COLUMN generated_at SET DEFAULT CURRENT_TIMESTAMP';
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = 'created_at' AND data_type = 'timestamp without time zone'
    ) THEN
        EXECUTE 'ALTER TABLE users ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE ''Africa/Nairobi''';
        EXECUTE 'ALTER TABLE users ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP';
    END IF;
END $$;

COMMIT;
