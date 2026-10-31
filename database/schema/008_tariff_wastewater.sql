-- Module 5: adds a wastewater price alongside each tariff band's existing
-- water price. The source tariff file's SU (water) rows already carry an
-- ATIKSU_FIYATI column with the matching wastewater price for the same
-- subscriber_type/band/date, so this is loaded from the same rows
-- database/load_tariffs.py already reads — no separate ATIK SU rows are
-- needed. Nullable: existing rows loaded before this migration simply
-- have no wastewater price until database/load_tariffs.py is re-run.
--
-- Run manually (see database/schema/README.md). Wrapped in a single
-- transaction: either all of this applies, or none of it does.

BEGIN;

ALTER TABLE tariffs ADD COLUMN IF NOT EXISTS wastewater_price_per_m3 NUMERIC(10, 2) NULL;

COMMIT;
