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
3. `002_published_forecast.sql` — adds the columns `forecasts` needs to
   distinguish a published forecast (`kind`, `data_up_to`, `train_start`,
   `train_end`, `interval_width`) from the old on-demand ones, plus an
   index on `(kind, generated_at)`. Existing rows default to `kind =
   'on_demand'`, preserving them as history. Runs as a single transaction.
4. `003_production_planning.sql` — Production Planning (Module 3): adds
   `plan_type`/`chosen_m3`/`reason`/`version`/`is_active` to
   `production_plans` (refuses to run if that table already has rows,
   since these are added `NOT NULL` with no backfill value), a CHECK that
   a custom plan always has a reason and note and a normal/safe plan never
   has a reason, partial/compound unique indexes enforcing one active plan
   per (forecast, month) and one row per (forecast, month, version),
   tightens `stock_entries.stock_m3` to `> 0`, and removes Admin's
   `plan:view` permission. Runs as a single transaction.
5. `004_accounts.sql` — Module 1, Part 1 (accounts): makes `users.password`
   nullable and adds `google_sub`/`last_login_at` for Google sign-in, a
   real CHECK on `auth_provider` (`'password' | 'google' | 'emergency'`),
   a new `data:view` permission (Admin gains it and loses
   `distribution:view`/`tariff:view`/`revenue:view`), and the
   `login_attempts` table the emergency-login lockout rule reads. `users.role`
   is left in place — it's dropped in Part 3. Runs as a single transaction.
6. `005_sessions.sql` — Module 1, Part 2A (sessions): adds the `sessions`
   table server-side Google/emergency logins use (only a SHA-256 hash of
   the session id is stored, never the raw id), with an index on
   `user_id`. Runs as a single transaction.
7. `006_remove_password_login.sql` — Module 1, Part 3A: deactivates every
   remaining `auth_provider = 'password'` account (kept, not deleted; one
   `audit_log` row per account) and deletes their sessions, then drops
   `users.role` — nothing reads it anymore now that `POST
   /api/auth/login` itself is deleted. Runs as a single transaction.
8. `007_role_names_job_title.sql` — Module 1, Part 4b: renames two roles'
   `display_name` (`production_manager` -> "Production Planner",
   `commercial_officer` -> "Commercial Analyst"; role *names*/codes and
   Admin's display name are unchanged), and adds a nullable
   `users.job_title VARCHAR(100)` the UI prefers over the role label when
   one is set. Runs as a single transaction.
9. `008_tariff_wastewater.sql` — Module 5 (Revenue Estimate): adds a
   nullable `tariffs.wastewater_price_per_m3 NUMERIC(10,2)` alongside the
   existing water `price_per_m3`. Re-run `database/load_tariffs.py`
   afterwards to populate it from the source tariff file's `ATIKSU_FIYATI`
   column (the same SU rows the loader already reads — no separate ATIK
   SU rows are needed). Runs as a single transaction.
10. `009_timestamptz.sql` — bug fix: converts `forecasts.generated_at` and
    `users.created_at` from `TIMESTAMP WITHOUT TIME ZONE` to `TIMESTAMPTZ`
    (every other timestamp column already was). Existing values are
    Nairobi wall-clock times on both the local and the Heroku database,
    so the conversion uses `AT TIME ZONE 'Africa/Nairobi'`. Safe to
    re-run — each column is only converted if it's still timestamp
    without time zone. Runs as a single transaction.

To roll back **in development only**, run `001_foundation_down.sql`,
`002_published_forecast_down.sql`, `003_production_planning_down.sql`,
`004_accounts_down.sql`, `005_sessions_down.sql`,
`006_remove_password_login_down.sql`, `007_role_names_job_title_down.sql`,
`008_tariff_wastewater_down.sql` and/or `009_timestamptz_down.sql`. None
of these are a safe production rollback — see the comment at the top of
each file for what it does and does not undo.

## Running a file

```bash
psql -U <your_db_user> -d <your_db_name> -f database/schema/000_existing_schema.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/001_foundation.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/002_published_forecast.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/003_production_planning.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/004_accounts.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/005_sessions.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/006_remove_password_login.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/007_role_names_job_title.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/008_tariff_wastewater.sql
psql -U <your_db_user> -d <your_db_name> -f database/schema/009_timestamptz.sql
```

Or open each file in pgAdmin's Query Tool against the target database and
execute it there.
