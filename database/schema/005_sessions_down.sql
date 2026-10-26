-- Reverses 005_sessions.sql. For development rollback only — every
-- signed-in cookie session is discarded (everyone using one gets
-- "Your session has expired" on their next request).

BEGIN;

DROP INDEX IF EXISTS idx_sessions_user_id;
DROP TABLE IF EXISTS sessions;

COMMIT;
