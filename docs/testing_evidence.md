# Testing and Evaluation Evidence - Sprint II

**What was tested:** the forecasting model (data quality, train/test evaluation,
baselines, cross-validation, tuning) and the system's login/API integration.
**Key result:** Prophet beats both naive baselines on the held-out test set —
MAPE 4.86%, vs. 5.47% (seasonal-naive) and 6.23% (last-year x growth).
**Issues found and fixed:** a synthetic dataset, a silent BIGINT/string bug,
a missing env path, a forecast date bug, and hardcoded test account
passwords — see Part C.

## Part A - Forecasting Model

| # | Test | Expected | Actual | Status |
|---|---|---|---|---|
| A1 | Data validation | Consumption data reflects real billing | Kaggle column was synthetic (exactly 1.025x the same month last year) - replaced with official İZSU data | ✅ Fixed |
| A2 | Data preparation | İZSU records aggregate cleanly to monthly totals | 1,143,347 records → 128 monthly totals (Jan 2014 - Aug 2024); water rows only; Sep 2024 excluded as incomplete | ✅ |
| A3 | Outlier handling | Known anomalous months are flagged | 5 months flagged and interpolated (2019-09; 2020-04/05/06 COVID meter-reading gap; 2020-08) | ✅ |
| A4 | Train/test split | 80/20 chronological split | 102 training months / 26 test months | ✅ |
| A5 | Prophet test results | Model evaluates on the 26 held-out months | MAE 1,027,291 m3, RMSE 1,308,929 m3, MAPE 4.86% | ✅ |
| A6 | Seasonal-naive baseline | Beatable by a real model | MAPE 5.47% | ✅ |
| A7 | Last-year x growth baseline | Beatable by a real model | MAPE 6.23% | ✅ |
| A8 | Cross-validation (training data only) | Consistent performance across folds | 12 folds, mean MAPE 6.76% | ✅ |
| A9 | Hyperparameter tuning | Tuning may improve on defaults | 24 combinations, cross-validation on training data only: leading configs within ~0.5 percentage points of defaults, changepoint_prior_scale=0.5 consistently worst; defaults kept. Test-set check confirmed (tuned 5.71% vs default 4.86%) | ✅ |
| A10 | Forecast output | 6-month forecast starts after the last known month | Starts 2024-09 with uncertainty bounds; follows seasonal pattern | ✅ |

**Model comparison (test set, 26 months):**

| Model | MAE (m3) | MAPE |
|---|---|---|
| Prophet | 1,027,291 | 4.86% |
| Seasonal-naive | 1,177,106 | 5.47% |
| Last-year x growth | 1,343,804 | 6.23% |

## Part B - System Integration

| # | Test | Expected | Actual | Status |
|---|---|---|---|---|
| B1 | Login, correct credentials | 200 + JWT | 200 + JWT returned | ✅ |
| B2 | Login, wrong password | 401 | 401 | ✅ |
| B3 | Forecast request, no token | 401 | 401 | ✅ |
| B4 | Admin-only endpoint as manager | 403 | 403 | ✅ |
| B5 | GET /api/forecast as manager | 200 with İZSU results | 200, MAE/RMSE/MAPE match ml script output | ✅ |
| B6 | GET /api/consumption-history as admin | 200, 128 rows | 200, 128 rows | ✅ |
| B7 | load_izsu.py | 128 rows loaded into izsu_consumption | 128 rows confirmed | ✅ |
| B8 | GET /api/forecast?horizon=3, 6, 12 | 200 with 3/6/12 forecast months | 200, correct row counts | ✅ |
| B9 | GET /api/forecast?horizon=99 (invalid input) | 400 with clear message | 400 "Invalid horizon. Must be 3, 6, or 12" | ✅ |
| B10 | Forecast saved to database | 1 row in forecasts + N rows in forecast_results | Rows saved and linked by forecast_id | ✅ |
| B11 | GET /api/forecasts/recent | 200, latest saved forecasts | 200, correct order | ✅ |
| B12 | Forecast response time | Under 10 seconds (NFR) | ~4 s (was ~17 s before loading the saved model) | ✅ |

## Part C - Issues Found and Fixed

| # | Issue | Fix |
|---|---|---|
| C1 | Consumption data was synthetic (exact 1.025x yearly pattern) | Replaced with official İZSU billed data |
| C2 | Postgres BIGINT returned as a string by `pg`, silently breaking frontend sums | Cast to `::double precision` in the query |
| C3 | `JWT_SECRET` was undefined when the backend ran from `backend/` | Explicit `.env` path passed to `dotenv.config()` |
| C4 | 6-month forecast showed historic (already-known) dates | Added a final retrain on all data before forecasting |
| C5 | Test account passwords hardcoded in seed_users.py | Moved to .env; .env.example added; users re-seeded |
| C6 | Open: frontend CRA test suite fails (react-router-dom/Jest resolution error) | Planned fix |

## Part D - Production Planning (Module 3)

Automated: `backend/test/planning.test.js` (`node --test`, run via `npm test`
in `backend/`) covers every pure calculation and validation rule in
`backend/planning.js` — normal/safe amounts (including the Sep 2024
25.4M → ~37.6M example at loss_rate 0.324), `daysInMonth` across leap and
short months, `calculateDaysOfCover`'s rounding-down and null cases, and
every `validatePlanRequest` branch (valid normal/safe/custom, a custom
plan missing its reason, missing or blank note, a note over 500
characters, a non-whole or non-positive `custom_m3`, `custom_m3` over and
exactly at the 3x-safe cap, and an unknown `plan_type`). 21/21 passing as
of this writing.

| Endpoint | What it checks |
|---|---|
| `GET /api/production/plan` | `plan:view`; 404 if no forecast is published; returns the 12 forecast months with freshly computed `normal_m3`/`safe_m3`, each month's active plan (or `null`), the latest stock entry, and `days_of_cover` for the first forecast month |
| `GET /api/production/plan/:month/history` | `plan:view`; 400 if `:month` isn't one of the latest published forecast's months; full version history for that month, newest first, with who created each version and when |
| `POST /api/production/plan` | `plan:create`; recomputes `normal`/`safe` server-side from `forecast_results` and the current `loss_rate` — never trusts a client-sent amount except `custom_m3`; 409 if `forecast_id` isn't the latest published one; 409 if `expected_version` doesn't match the month's current active version (optimistic concurrency); 400 if the month isn't in the forecast or the body fails `validatePlanRequest`; saves the new version and deactivates the old one, plus a `plan.save` audit row, in one transaction |
| `GET /api/production/stock` | `plan:view`; stock entries within 90 days of the most recent reading (max 200 rows), newest first, each with `recorded_by` and a `change_m3` computed with a `LAG` window function over *all* entries (not just the windowed ones) so the oldest row in the window still compares against the real reading before it; `null` for the very first reading ever |
| `POST /api/production/stock` | `stock:create`; 400 if `recorded_on` isn't a valid date, is after the **database's** `CURRENT_DATE`, or `stock_m3` isn't a positive whole number; inserts the entry plus a `stock.record` audit row in one transaction |

**Manual checks to run after applying `database/schema/003_production_planning.sql`:**

| # | Check | Expected |
|---|---|---|
| D1 | Admin calls `GET /api/production/plan` | 403 — `003_production_planning.sql` removed `plan:view` from the admin role |
| D2 | Production manager calls `GET /api/production/plan` | 200 |
| D3 | Production manager calls `POST /api/production/stock` | 200/201 — manager has `stock:create` |
| D4 | Commercial officer calls `GET /api/production/plan` or `POST /api/production/plan` | 403 for both — role has neither `plan:view` nor `plan:create` |
| D5 | `POST /api/production/plan` with `plan_type: "custom"` and no `reason` | 400 with a field-level error naming `reason` |
| D6 | Two browser tabs both load the same month, one saves a plan, the other then saves with its (now stale) `expected_version` | Second save gets 409 "This plan was changed by someone else." |
| D7 | `POST /api/production/stock` with `recorded_on` set to tomorrow | 400 naming `recorded_on`, rejected against the database's date, not the browser's |
| D8 | After D3/D5(fixed)/any successful plan save | A new row appears in `audit_log` with `action = 'plan.save'` or `'stock.record'`, the correct `user_id`, and `details` containing the month/plan_type/chosen_m3/version (or recorded_on/stock_m3) |

## Part E - Accounts (Module 1, Part 1)

Database and account-provisioning scripts only — no login route changes
yet (Google sign-in and the emergency-login lockout rule are later parts
of this module). The existing password login was not touched and must
keep working exactly as before.

**Manual checks to run after applying `database/schema/004_accounts.sql`:**

| # | Check | Expected |
|---|---|---|
| E1 | `\d users` in `psql` | `password` is nullable; `google_sub` (`varchar(255)`, unique) and `last_login_at` (`timestamptz`) exist; a `users_auth_provider_check` CHECK constraint exists |
| E2 | `INSERT ... users (auth_provider) VALUES ('google')` / `'emergency'` | Both succeed; `UPDATE users SET auth_provider = 'bogus'` is rejected by the CHECK |
| E3 | `SELECT p.code FROM role_permissions rp JOIN roles r ON r.role_id=rp.role_id JOIN permissions p ON p.permission_id=rp.permission_id WHERE r.name='admin'` | Does **not** include `distribution:view`, `tariff:view`, `revenue:view`, or `plan:view` (removed in 003); **does** include `data:view` |
| E4 | `\d login_attempts` | Table exists with `attempt_id`, `ip_address`, `attempted_at`, `succeeded`; an index on `(ip_address, attempted_at)` |
| E5 | `python database/create_emergency_admin.py` with `EMERGENCY_ADMIN_EMAIL`/`EMERGENCY_ADMIN_PASSWORD` unset | Exits with a clear error, no traceback |
| E6 | Same script with `EMERGENCY_ADMIN_PASSWORD` set to 10 characters | Exits with a clear "at least 16 characters" error |
| E7 | Same script with both set validly, run twice | First run creates the user (`auth_provider='emergency'`, `role='admin'`, `status='active'`); second run updates the same row (same `user_id`) rather than erroring or duplicating; `audit_log` gets one `emergency_admin.set` row per run; the password itself never appears in terminal output |
| E8 | `python database/invite_user.py --name "..." --email ... --role production_manager` | Creates a `status='invited'`, `auth_provider='google'`, `password IS NULL` row with `role='manager'` and the matching `role_id`; an `audit_log` row with `action='user.invited'` |
| E9 | Same command again with the same `--email` | Refuses with a clear "already exists" error; no second row, no audit row |
| E10 | `python database/invite_user.py --role bogus ...` | `argparse` rejects it immediately (invalid choice), before touching the database |
| E11 | `POST /api/auth/login` with an existing password-based account's correct credentials | Still 200 + JWT, unchanged — confirms making `password` nullable didn't break the existing bcrypt comparison for rows that still have one |

## Part F - Google sign-in & sessions (Module 1, Part 2A)

Automated: `backend/test/auth.test.js` (`node --test`) covers every pure
helper in `backend/auth.js` — `getIdleTimeoutMs` (30 min admin / 60 min
everyone else), `computeSessionExpiry` (idle timeout vs. the 8-hour
absolute cap, for both admin and non-admin), `getSessionCookieOptions`
(`secure` only in production), the shape and uniqueness of
`generateSessionId`/`generateCsrfToken`, `hashSessionId`'s determinism,
`csrfTokensMatch` (equal/unequal/different-length/non-string/empty), and
`isBlockedByFailedAttempts`'s threshold (4 allowed, 5 blocked). 34/34
passing (9 new + the 25 from Part D) as of this writing.

**Manual checks to run after applying `database/schema/005_sessions.sql`
and setting `EMERGENCY_ADMIN_EMAIL`/`EMERGENCY_ADMIN_PASSWORD`/`GOOGLE_CLIENT_ID`:**

| # | Check | Expected |
|---|---|---|
| F1 | `POST /api/auth/emergency-login` with the emergency admin's correct email/password | 200, a `sid` cookie is set (`HttpOnly`; `Secure` only when `NODE_ENV=production`), response includes `csrf_token` and `session_expires_at`; a `sessions` row and an `audit_log` row with `action='emergency.login'` and `details.severity='warning'` both appear |
| F2 | Same endpoint with the right email but a wrong password | 401 "Invalid email or password" — the same generic message as an unknown email; `login_attempts` gets a `succeeded=false` row; `audit_log` gets an `emergency.login_failed` row |
| F3 | Repeat F2 five times from the same IP in under 15 minutes, then try a 6th time (even with the *correct* password) | The 6th attempt gets 429 "Too many attempts. Try again in 15 minutes." without checking the password, and does **not** add another `login_attempts` row |
| F4 | `GET /api/me` sent with the `sid` cookie from F1 | 200 `{ user_id, name, email, role (roles.name, e.g. "admin"), role_label ("Admin"), permissions: [...], csrf_token, session_expires_at }` |
| F5 | `GET /api/me` sent with the old Bearer JWT (no cookie) | 200, same shape but **without** `csrf_token`/`session_expires_at` — confirms those two are cookie-session-only |
| F6 | `POST /api/auth/logout` with the `sid` cookie and the matching `X-CSRF-Token` header | 204; the `sessions` row is gone; the cookie is cleared; a follow-up request with the same (now-stale) cookie gets 401 "Your session has expired. Please sign in again." |
| F7 | `POST /api/production/stock` (or `/plan`) with a valid `sid` cookie but **no** `X-CSRF-Token` header, or the wrong one | 403 "Security check failed. Reload the page and try again." |
| F8 | Same request, with the correct `X-CSRF-Token` from `GET /api/me` | Succeeds as normal — confirms CSRF protection doesn't block legitimate cookie-authenticated writes |
| F9 | The same two POST endpoints called the old way, with `Authorization: Bearer <JWT>` and no cookie at all | Still succeed with no CSRF header needed — confirms Bearer requests stay exempt |
| F10 | `POST /api/auth/login` (the original password route) with correct credentials | Still 200 + JWT, byte-for-byte the same response shape as before — confirms the Bearer/password path is genuinely untouched |
| F11 | Wait past the idle timeout (30 min admin / 60 min others) without any request, then make one | 401 "Your session has expired. Please sign in again."; the expired `sessions` row is deleted by that same request |
| F12 | Keep a session alive with requests every few minutes past the 8-hour mark from `created_at` | Still expires at the 8-hour absolute limit regardless of how recently the last request was |

## Part G - Removing password login (Module 1, Part 3A)

Automated: `backend/test/auth.test.js` and `backend/test/planning.test.js`
are unaffected by this part (neither touches `users.role` or the login
route) — `npm test` in `backend/` should still show the same pass count as
Part F. `frontend/src/App.test.js` was replaced (the default CRA
"learn react" test never meant anything here) with five small tests of
`getFirstPermittedPath` in `layout/menuConfig.js`; `npm test --
--watchAll=false` in `frontend/` should pass.

**Manual checks to run after applying `database/schema/006_remove_password_login.sql`:**

| # | Check | Expected |
|---|---|---|
| G1 | `\d users` in `psql` | No `role` column; `role_id` is still there |
| G2 | Before running 006, note every `user_id` with `auth_provider = 'password'`; after running it, `SELECT status, deactivated_at, deactivation_reason FROM users WHERE user_id = ...` for each | `status = 'deactivated'`, `deactivated_at` set, `deactivation_reason = 'Password login removed; replaced by Google sign-in'`; the row still exists (not deleted) |
| G3 | `SELECT * FROM audit_log WHERE action = 'user.deactivated'` | One row per account from G2, `user_id IS NULL`, `entity = 'users'`, `entity_id` = that account's id, `details->>'reason'` matches the deactivation reason |
| G4 | `SELECT * FROM sessions WHERE user_id = <a deactivated account's id>` | No rows — any session that account had is gone |
| G5 | `POST /api/auth/login` (any credentials) | 404 — the route no longer exists |
| G6 | `GET /api/me` (or any protected route) with an old `Authorization: Bearer <JWT>` header and no `sid` cookie | 401 "Your session has expired. Please sign in again." — the Bearer fallback is gone, cookie sessions only |
| G7 | `POST /api/auth/google` with a valid Google credential, and `POST /api/auth/emergency-login` with the emergency admin's credentials | Both still 200, set the `sid` cookie, and return the same payload shape as Part F — unaffected by this part |
| G8 | `GET /api/consumption-history` (or any `requirePermission`-guarded route) signed in as a user without that permission | 403 "You don't have permission to do this."; `SELECT * FROM audit_log WHERE action = 'permission.denied' ORDER BY occurred_at DESC LIMIT 1` shows a fresh row with `details` containing the permission code, HTTP method and path |
| G9 | Temporarily stop the database (or revoke the DB user's privileges) and repeat G8 | Still 403 is never returned as a 500 instead — `requirePermission`'s audit-log write failure (logged to the console) must not change the response; confirms the audit write is best-effort |
| G10 | In the browser, sign in as a user who lacks `data:view` (or `plan:view`) and open `/data-overview` (or `/production-planning`) directly | The page's normal sidebar/topbar still show; the content area shows "You don't have access to this page." with a button that goes to a page the user does have permission for |
| G11 | Sign in, then use the top bar's Logout button | Redirected to `/login`; the page shows "You've signed out." |
| G12 | `cat backend/package.json` | No `jsonwebtoken` in `dependencies` |
