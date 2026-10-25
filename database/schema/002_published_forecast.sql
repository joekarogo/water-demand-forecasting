-- Adds the columns needed to distinguish a PUBLISHED forecast (computed
-- once after training, shown instantly by the website) from the old
-- per-request on-demand forecasts (now removed from the API, but their
-- rows stay as history). Existing rows default to 'on_demand'.

BEGIN;

ALTER TABLE forecasts
    ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'on_demand'
        CHECK (kind IN ('on_demand', 'published')),
    ADD COLUMN IF NOT EXISTS data_up_to DATE,
    ADD COLUMN IF NOT EXISTS train_start DATE,
    ADD COLUMN IF NOT EXISTS train_end DATE,
    ADD COLUMN IF NOT EXISTS interval_width NUMERIC(3, 2);

CREATE INDEX IF NOT EXISTS idx_forecasts_kind_generated_at ON forecasts(kind, generated_at);

COMMIT;
