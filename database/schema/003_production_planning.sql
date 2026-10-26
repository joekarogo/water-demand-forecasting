-- Production Planning (Module 3): adds the plan_type/chosen_m3/reason/
-- version/is_active columns production_plans needs to track plan history
-- per month, tightens stock_entries.stock_m3 to a genuinely positive
-- amount, and removes Admin's plan:view permission (production planning
-- is a Production Manager responsibility, not an Admin one).
--
-- Guarded: refuses to run if production_plans already has rows, since the
-- new columns are added NOT NULL with no backfill value — this migration
-- is only safe on an empty production_plans table.
--
-- Run manually (see database/schema/README.md). Wrapped in a single
-- transaction: either all of this applies, or none of it does.

BEGIN;

DO $$
DECLARE
    plan_count INT;
BEGIN
    SELECT COUNT(*) INTO plan_count FROM production_plans;
    IF plan_count > 0 THEN
        RAISE EXCEPTION
            'Refusing to migrate: production_plans already has % row(s). This migration adds NOT NULL columns with no backfill value.',
            plan_count;
    END IF;
END $$;

ALTER TABLE production_plans
    ALTER COLUMN forecast_id SET NOT NULL,
    ADD COLUMN plan_type VARCHAR(10) NOT NULL CHECK (plan_type IN ('normal', 'safe', 'custom')),
    ADD COLUMN chosen_m3 BIGINT NOT NULL CHECK (chosen_m3 > 0),
    ADD COLUMN reason VARCHAR(30) NULL CHECK (reason IN (
        'planned_maintenance', 'drought_restrictions', 'expected_event', 'supply_constraint', 'other'
    )),
    ADD COLUMN version INTEGER NOT NULL CHECK (version >= 1),
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;

-- A custom plan must explain itself (a reason code plus a non-empty note,
-- reusing the existing `notes` column); a normal/safe plan must NOT carry
-- a reason — the plan type itself is the explanation.
ALTER TABLE production_plans
    ADD CONSTRAINT production_plans_custom_requires_reason_note CHECK (
        (plan_type = 'custom' AND reason IS NOT NULL AND notes IS NOT NULL AND length(trim(notes)) > 0)
        OR (plan_type IN ('normal', 'safe') AND reason IS NULL)
    );

-- At most one ACTIVE plan per (forecast, month) — superseding a plan sets
-- the old row's is_active to false rather than deleting it, so the full
-- version history survives.
CREATE UNIQUE INDEX idx_production_plans_one_active
    ON production_plans (forecast_id, plan_month)
    WHERE is_active;

-- Each (forecast, month) can only have one row per version number.
CREATE UNIQUE INDEX idx_production_plans_forecast_month_version
    ON production_plans (forecast_id, plan_month, version);

-- A stock reading of exactly 0 almost certainly means "not recorded yet",
-- not "confirmed empty reservoirs" — reject it at entry rather than
-- silently accepting a value that would make days-of-cover read as 0.
ALTER TABLE stock_entries DROP CONSTRAINT IF EXISTS stock_entries_stock_m3_check;
ALTER TABLE stock_entries ADD CONSTRAINT stock_entries_stock_m3_check CHECK (stock_m3 > 0);

-- Production planning is a Production Manager responsibility; Admin
-- doesn't need to view plans. Set-based on role name / permission code,
-- like 001_foundation.sql.
DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.role_id
  AND rp.permission_id = p.permission_id
  AND r.name = 'admin'
  AND p.code = 'plan:view';

COMMIT;
