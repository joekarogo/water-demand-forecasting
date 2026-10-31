-- Reverses 008_tariff_wastewater.sql. For development rollback only — any
-- wastewater_price_per_m3 values already loaded are simply dropped.

BEGIN;

ALTER TABLE tariffs DROP COLUMN IF EXISTS wastewater_price_per_m3;

COMMIT;
