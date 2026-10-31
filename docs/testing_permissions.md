# Permission matrix test

`backend/test/permissions.matrix.test.js` exercises every protected route
against a real copy of the app (`backend/app.js`) and a real, disposable
database — not mocks. It's skipped by default and only runs once you
point it at a database of its own.

## 1. Create a disposable test database (once)

```bash
createdb water_forecasting_test
```

Use a **different** database from the one in your `.env` (`DB_NAME`), and
give it a name ending in `_test` — the test refuses to run against
anything else (see step 2). You only need to create it once: every run
now wipes it clean itself (`DROP SCHEMA public CASCADE; CREATE SCHEMA
public;`) before applying migrations, so there's no need to `dropdb`/
`createdb` between runs, or to worry about leftover data from a previous
run (migrations 001's `roles`/`permissions` seed rows aren't idempotent,
and the matrix's own fixture users would otherwise collide).

## 2. Set `TEST_DATABASE_URL`

Add this yourself to the project root `.env` (the test file loads it the
same way the app does; nothing here touches your real `.env` for you):

```
TEST_DATABASE_URL=postgres://<user>:<password>@localhost:5432/water_forecasting_test
```

The test refuses to run at all if this resolves to the same host, port
and database name as `DB_HOST`/`DB_PORT`/`DB_NAME` — it will never touch
your real data, even by mistake — and it also refuses to run if the
database name doesn't end in `_test`, since it's about to drop and
recreate that database's `public` schema and only ever does that to
something unmistakably disposable.

## 3. Run it

```bash
cd backend
npm test
```

Without `TEST_DATABASE_URL` set, `npm test` still runs everything else
(the pure-helper unit tests) and reports the permission matrix as
**skipped**, with a message pointing back at this file — it never fails
a normal `npm test` run just because the test database isn't set up.

With `TEST_DATABASE_URL` set, the same `npm test` run additionally:

1. Wipes the test database (`DROP SCHEMA public CASCADE; CREATE SCHEMA
   public;`), so every run starts from a clean slate regardless of what
   a previous run left behind.
2. Applies `database/schema/000_existing_schema.sql` through
   `007_role_names_job_title.sql`, in order, to the now-empty database.
3. Creates one active user per role (`admin`, `production_manager`,
   `commercial_officer`), one deactivated user, and a handful of
   dedicated throwaway users for the role-change/deactivate/reactivate
   checks — all with sessions inserted directly into the `sessions`
   table (no Google sign-in involved).
4. Starts `backend/app.js` on a random local port, pointed at the test
   database via `DATABASE_URL` (which takes priority over `DB_HOST`/
   `DB_NAME`/etc. in `backend/app.js`'s pool setup).
5. Sends real HTTP requests at it with Node's built-in `fetch`, for every
   route below, and checks the status code.

## The expected matrix

Permissions come from `database/schema/001_foundation.sql`, as narrowed
by `003_production_planning.sql` (removes admin's `plan:view`) and
`004_accounts.sql` (removes admin's `distribution:view`/`tariff:view`/
`revenue:view`, adds `data:view`). Today that leaves:

| Role | Permissions |
|---|---|
| `admin` | `forecast:view`, `user:manage`, `settings:edit`, `audit:view_all`, `report:view`, `report:export`, `data:view` |
| `production_manager` | `forecast:view`, `plan:view`, `plan:create`, `stock:create`, `distribution:view`, `audit:view_own`, `report:view`, `report:export` |
| `commercial_officer` | `forecast:view`, `tariff:view`, `tariff:edit`, `revenue:view`, `audit:view_own`, `report:view`, `report:export` |

For every route, the matrix checks: no cookie (401), the deactivated
fixture user (401), each active role's expected status, and — for every
POST/PATCH route — the allowed role's request again with the
`X-CSRF-Token` header left off (403).

| Route | Permission | admin | production_manager | commercial_officer |
|---|---|---|---|---|
| `GET /api/forecast/published` | `forecast:view` | 200 | 200 | 200 |
| `GET /api/consumption-history` | `data:view` | 200 | 403 | 403 |
| `GET /api/production/plan` | `plan:view` | 403 | 200 | 403 |
| `GET /api/production/plan/:month/history` | `plan:view` | 403 | 200 | 403 |
| `POST /api/production/plan` | `plan:create` | 403 | 200 | 403 |
| `GET /api/production/stock` | `plan:view` | 403 | 200 | 403 |
| `GET /api/distribution` | `distribution:view` | 403 | 200 | 403 |
| `POST /api/production/stock` | `stock:create` | 403 | 200 | 403 |
| `GET /api/roles` | `user:manage` | 200 | 403 | 403 |
| `GET /api/users` | `user:manage` | 200 | 403 | 403 |
| `POST /api/users` | `user:manage` | 201 | 403 | 403 |
| `PATCH /api/users/:id/role` | `user:manage` | 200 | 403 | 403 |
| `POST /api/users/:id/deactivate` | `user:manage` | 200 | 403 | 403 |
| `POST /api/users/:id/reactivate` | `user:manage` | 200 | 403 | 403 |
| `PATCH /api/users/:id/job-title` | `user:manage` | 200 | 403 | 403 |
| `GET /api/me` | *(authenticated only)* | 200 | 200 | 200 |
| `GET /api/me/sign-ins` | *(authenticated only)* | 200 | 200 | 200 |
| `GET /api/about` | *(authenticated only)* | 200 | 200 | 200 |
| `POST /api/auth/logout` | *(authenticated only)* | 204 | 204 | 204 |

The role-change, deactivate and reactivate routes are also gated by
"step-up" re-authentication (`auth.isWithinStepUpWindow` — the session
must have been created in the last 10 minutes); `job-title` is not — a
job title isn't security-sensitive, so it only needs `user:manage` and
CSRF. The matrix's fixture sessions are always freshly created, so every
status above reflects the **permission** check only, not the reauth one;
`backend/test/auth.test.js` covers the reauth rule itself.

A few checks beyond the table above also run inside this same test:
`GET /api/me/sign-ins` only ever returns the calling user's own rows
(checked with two fixture users who each have a distinct seeded
sign-in audit row); every response carries an `X-Session-Expires-In`
header (whole seconds remaining) and an `X-Session-Max-Reached` header
(`"false"` for the matrix's always-freshly-created fixture sessions);
and an unmatched `/api/*` path returns a JSON 404 rather than Express's
default HTML one.
