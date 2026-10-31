-- Reverses 007_role_names_job_title.sql. For development rollback only —
-- any job_title values already entered are simply dropped.

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS job_title;

UPDATE roles SET display_name = 'Production Manager' WHERE name = 'production_manager';
UPDATE roles SET display_name = 'Commercial Officer' WHERE name = 'commercial_officer';

COMMIT;
