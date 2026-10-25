# Database Schema

Migration files in this folder are run manually in pgAdmin or `psql` —
there is no automated migration runner in this project yet.

## Run order

1. `000_existing_schema.sql` — reproduces the tables that already exist
   (`users`, `izsu_consumption`, `forecasts`, `forecast_results`) as
   `CREATE TABLE IF NOT EXISTS`, so a fresh database ends up with the same
   schema a long-running one already has. A no-op on a database that
   already has these tables.
2. `001_foundation.sql` — the foundation migration: drops the unused
   `production_records` / `analytics_reports` tables (refuses to if either
   unexpectedly contains rows), adds RBAC (`roles`, `permissions`,
   `role_permissions`, and new columns on `users`), and adds the tables for
   the planned modules (consumption detail, tariffs, water balance,
   settings, production planning, audit log). Runs as a single transaction.

To roll back **in development only**, run `001_foundation_down.sql`. It is
not a safe production rollback — see the comment at the top of that file
for what it does and does not undo.

## Running a file

```bash
psql -U <your_db_user> -d <your_db_name> -f database/schema/000_existing_schema.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/001_foundation.sql
```

Or open each file in pgAdmin's Query Tool against the target database and
execute it there.
