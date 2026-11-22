-- Stored water readings (Module 3): mirrors the versioning already used
-- for production_plans (003_production_planning.sql) — a reading no
-- longer overwrites silently. The previous reading for a date is kept,
-- marked state = 'replaced' (corrected) or 'removed' (withdrawn), never
-- deleted; only state = 'active' is ever read by the app as "the"
-- reading for a date.
--
-- Existing data: if a recorded_on already has more than one row (the
-- silent-overwrite bug this fixes), the highest entry_id is kept active
-- and every earlier row for that date is backfilled to state =
-- 'replaced', so this migration is safe to run even where the bug has
-- already produced duplicates.
--
-- Also seeds the storage_capacity_m3 setting the new "amount above
-- capacity" validation reads, from the same dam-data source the
-- Production Planning page already cites elsewhere.
--
-- Run manually (see database/schema/README.md). Wrapped in a single
-- transaction: either all of this applies, or none of it does.

BEGIN;

ALTER TABLE stock_entries
    ADD COLUMN state VARCHAR(10) NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'replaced', 'removed')),
    ADD COLUMN change_reason TEXT NULL,
    ADD COLUMN changed_by INTEGER NULL REFERENCES users(user_id),
    ADD COLUMN changed_at TIMESTAMPTZ NULL;

-- Backfill: for any recorded_on with more than one row today, keep the
-- highest entry_id active and mark the rest replaced — the same
-- resolution the app itself applies going forward via a correction.
WITH ranked AS (
    SELECT entry_id,
           ROW_NUMBER() OVER (PARTITION BY recorded_on ORDER BY entry_id DESC) AS rn
    FROM stock_entries
)
UPDATE stock_entries se
SET state = 'replaced',
    change_reason = 'Superseded by a later reading on the same date (migration 010)',
    changed_at = now()
FROM ranked
WHERE se.entry_id = ranked.entry_id
  AND ranked.rn > 1;

-- A replaced/removed row must always say why; an active one never needs
-- to (there's nothing to explain yet).
ALTER TABLE stock_entries
    ADD CONSTRAINT stock_entries_state_requires_reason CHECK (
        state = 'active' OR change_reason IS NOT NULL
    );

-- At most one ACTIVE reading per date — mirrors
-- idx_production_plans_one_active in 003_production_planning.sql. Only
-- safe to create now that the backfill above has resolved any existing
-- same-date duplicates down to one active row each.
CREATE UNIQUE INDEX idx_stock_entries_one_active_per_date
    ON stock_entries (recorded_on)
    WHERE state = 'active';

INSERT INTO settings (key, value, unit, source) VALUES
    ('storage_capacity_m3', '776422000', 'm3',
     'IZSU dam data (izsu-baraj-doluluk-oranlari.csv, 14 Oct 2026): usable lake volume of Gordes 457,500,000 + Tahtali 287,050,000 + Alacati Kutlu Aktas 16,000,000 + Urkmez 8,250,000 + Balcova 7,622,000 m3')
ON CONFLICT (key) DO NOTHING;

COMMIT;
