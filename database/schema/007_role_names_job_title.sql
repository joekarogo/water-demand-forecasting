-- Module 1, Part 4b: friendlier display names for two roles, plus a
-- per-user free-text job title that the UI prefers over the role label
-- when one is set. Role NAMES (codes) are unchanged — only
-- roles.display_name, which is all the frontend ever showed as
-- role_label, moves; nothing keys off the old English text.
--
-- Run manually (see database/schema/README.md). Wrapped in a single
-- transaction: either all of this applies, or none of it does.

BEGIN;

UPDATE roles SET display_name = 'Production Planner' WHERE name = 'production_manager';
UPDATE roles SET display_name = 'Commercial Analyst' WHERE name = 'commercial_officer';
-- Admin's display_name ('Admin') is unchanged.

ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(100) NULL;

COMMIT;
