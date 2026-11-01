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

## Part H - The Users page (Module 1, Part 4)

Automated: `backend/test/users.test.js` (the new pure helpers in
`backend/users.js`) and the step-up-window tests added to
`backend/test/auth.test.js` — `npm test` in `backend/` should show a
higher pass count than Part G, 0 failures, with the permission matrix
reported as **skipped** unless `TEST_DATABASE_URL` is set (see
`docs/testing_permissions.md` for running that one). `npm run build` and
`npm test -- --watchAll=false` in `frontend/` must both pass.

**Manual checks (signed in as an Admin, with a second Admin account
available so the "last active Admin" checks don't lock you out):**

| # | Check | Expected |
|---|---|---|
| H1 | Open `/users` as a `production_manager` or `commercial_officer` | Sidebar has no "Users" item (no `user:manage`); typing the URL directly shows "You don't have access to this page." inside the normal layout |
| H2 | Open `/users` as Admin | Table of every user: name, email, role, a status badge (Active/Invited/Deactivated), last sign-in (or "—" if never signed in); your own row shows "You" |
| H3 | An emergency account (if one exists) appears in the list | Shown with an "Emergency" tag; its row's "Change role" control is disabled |
| H4 | Search by part of a name, then by part of an email | Table narrows to matches on either field; clear the box and everything returns |
| H5 | Filter by role, then by status, then both together | Table narrows accordingly; an honest empty state ("No users match your search or filters.") with a "Clear filters" button when a filter excludes everyone |
| H6 | Click "Invite user", submit with name/email blank | Client-side field errors, no request sent |
| H7 | Invite with a malformed email (e.g. `bob@bob`) | Client-side "Enter a valid email address." |
| H8 | Invite with a valid name/email/role | 201; new row appears in the table immediately (`status = invited`, `auth_provider = google`) without a full page reload; `audit_log` gets a `user.invited` row |
| H9 | Invite the same email again (any casing) | 409 "A user with this email already exists."; the name/email/role you typed are still in the form (not cleared) so you can fix and retry |
| H10 | `python database/invite_user.py --role bogus ...` still works unchanged, and a role sent as `"role": "bogus"` via `POST /api/users` | `argparse` rejects the script call as before; the API calls returns 400 with `fields.role` |
| H11 | Click your own row | "Change role" and "Deactivate" are disabled; a note explains why |
| H12 | Click another Admin's row, change their role away from Admin, when they're the only other active Admin and you count as the first | Change succeeds only if at least one active Admin remains afterward; otherwise 409 "There must be at least one active Admin." |
| H13 | Change a non-Admin user's role | 200; the row updates in place; `audit_log` gets a `user.role_changed` row with `from`/`to` |
| H14 | Click "Deactivate this user" on someone else, submit with an empty reason, then a 4-character reason | Client-side (or server 400, if you bypass the client check) "Enter a reason (at least 5 characters)." |
| H15 | Confirm a deactivation with a valid reason | 200; status badge flips to "Deactivated"; `SELECT * FROM sessions WHERE user_id = ...` for that user is empty (signed out immediately); `audit_log` gets a `user.deactivated` row |
| H16 | Try to deactivate the last active Admin (deactivate every other Admin first) | 409 "There must be at least one active Admin." |
| H17 | Open a deactivated user's row and reactivate them | 200; status becomes "Active" (if they'd signed in with Google before) or "Invited" (if not); `audit_log` gets a `user.reactivated` row |
| H18 | Wait more than 10 minutes after signing in (or manually age a session's `created_at` in `sessions`), then try to change a role / deactivate / reactivate | 403 `{ "error": "For security, sign in again to make this change.", "code": "reauth_required" }`; the panel shows that message with a "Sign in again" button |
| H19 | Click "Sign in again" from H18 | Signs out (the session is gone server-side) and lands on `/login` showing "Sign in again to continue." |
| H20 | Resize the browser to 375px wide on `/users`, with the invite panel and a detail panel each open in turn | No horizontal scrollbar on the page itself; the table scrolls internally if needed; both panels stay within the viewport |
| H21 | Tab through the invite panel and a detail panel | Focus is trapped inside the open panel (Tab wraps from last to first field and back), Escape closes it and returns focus to the control that opened it |

**Permission matrix** (separate test database, see
`docs/testing_permissions.md` for setup):

| # | Check | Expected |
|---|---|---|
| H22 | `npm test` in `backend/` with no `TEST_DATABASE_URL` set | Permission matrix reported as **skipped**, clear message pointing at `docs/testing_permissions.md`; every other test still runs and passes |
| H23 | Set `TEST_DATABASE_URL` to the **same** `DB_HOST`/`DB_PORT`/`DB_NAME` as the real `.env`, run `npm test` | Refuses to run, with a clear failure message — never touches the real database |
| H24 | Set `TEST_DATABASE_URL` to a separate, freshly-created database, run `npm test` | Applies migrations 000-007, seeds fixtures, and checks every route in the table in `docs/testing_permissions.md` — 0 failures |

## Part I - Role display names and job titles (Module 1, Part 4b)

Automated: `backend/test/users.test.js` gets new tests for
`validateJobTitle` and `validateInviteRequest`'s `job_title` field;
`backend/test/permissions.matrix.test.js` now also applies
`007_role_names_job_title.sql` and checks `PATCH /api/users/:id/job-title`
(see `docs/testing_permissions.md`). `npm test` in `backend/` should show
a higher pass count than Part H, 0 failures. `npm run build` and
`npm test -- --watchAll=false` in `frontend/` must both pass.

**Manual checks (after applying `database/schema/007_role_names_job_title.sql`):**

| # | Check | Expected |
|---|---|---|
| I1 | `SELECT name, display_name FROM roles ORDER BY name` | `admin` → "Admin" (unchanged), `commercial_officer` → "Commercial Analyst", `production_manager` → "Production Planner" — role *names* (codes) are untouched |
| I2 | `\d users` | A new nullable `job_title VARCHAR(100)` column |
| I3 | `GET /api/me` and `GET /api/users` for any user | Both responses include `job_title` (`null` until set) |
| I4 | Open `/users` as Admin, open the sign-in top bar for a user with no job title set | Top bar shows the role label ("Production Planner" / "Commercial Analyst" / "Admin"), matching whatever `roles.display_name` currently is — not a hard-coded English string anywhere in the frontend |
| I5 | Invite a user with a job title (e.g. "Field Supervisor") | 201; the new row shows "Field Supervisor" under the name in the table instead of needing the role column; `audit_log`'s `user.invited` row includes it |
| I6 | Invite a user leaving job title blank | 201; `job_title` is `null`; the table falls back to showing nothing extra under the name |
| I7 | Invite with a job title over 100 characters | Client-side "The job title can be at most 100 characters."; bypassing the client check, the server returns the same 400 on `fields.job_title` |
| I8 | Open any user's detail panel, set/change their job title, save | 200; `audit_log` gets a `user.job_title_changed` row with the new value; the table and top bar (if it's your own account) update without a reload |
| I9 | Set a job title, then sign in as that user and look at the top bar | Shows the name plus the job title, not the role label |
| I10 | Clear a user's job title (empty the field and save) | 200; `job_title` becomes `null`; the UI falls back to the role label again |
| I11 | Change a job title while **not** within the 10-minute step-up window (age the session like H18) | Still succeeds (200) — job title changes are not gated by `requireRecentAuth`, unlike role changes |
| I12 | `python database/invite_user.py --name "Jane Doe" --email jane@example.com --role production_manager --job-title "Field Supervisor"` | Creates the user with that job title; omitting `--job-title` leaves it `NULL`; a title over 100 characters exits with a clear error before touching the database |
| I13 | `grep -rn "Production Manager\|Commercial Officer" frontend/src` | No matches — every role label the frontend shows comes from the API (`role_label`) or, failing that, a generic prettified version of the role code, never a hard-coded English label |

## Part J - Common website elements (Module 1, Part 4c)

Page titles/favicon, skip links, a 404 page, a user menu, `GET /api/me/sign-ins`,
`GET /api/about`, the session-expiry warning, and the My account/Help/Privacy/About
pages. Automated: `backend/test/permissions.matrix.test.js` adds `GET /api/roles`*,
`GET /api/me/sign-ins` and `GET /api/about` to its route table, plus dedicated checks
for own-rows-only, the `X-Session-Expires-In`/`X-Session-Max-Reached` headers, and
the `/api` JSON 404. `frontend/src/{NotFound,AppLayout,TopBar,SessionExpiryWarning}.test.js`
cover the 404 route, the skip link, `document.title`, the user menu (open/Escape),
and the expiry dialog (fake timers). `npm test` in `backend/` and
`npm test -- --watchAll=false` + `npm run build` in `frontend/` must all pass.

*`GET /api/roles` was added in a separate, earlier change on this branch; listed
here only because it's covered by the same test run.

| Requirement | Input | Expected | Actual | Pass/Fail | Evidence |
|---|---|---|---|---|---|
| J1 | Load `/dashboard`, `/login`, `/emergency-login`, and an unknown URL | `document.title` is `"<Page> · Water Demand Forecasting"` for each (e.g. "Demand Forecast", "Sign in", "Emergency sign-in", "Page not found") | Automated: `AppLayout.test.js` and `NotFound.test.js` assert the exact title string | Pass | `npm test -- --watchAll=false` in `frontend/`: `AppLayout.test.js`, `NotFound.test.js` green |
| J2 | Open the site; inspect the browser tab icon and `view-source:` the `<head>` | A water-drop favicon (`favicon.svg`); no `favicon.ico`/`logo192.png`/`logo512.png` references; `manifest.json` names the app and points only at `favicon.svg` | pending manual test | — | — |
| J3 | On `/login`, `/emergency-login`, and any signed-in page, press Tab once from a fresh page load | First stop is a visually-hidden "Skip to main content" link; activating it moves focus to the page's `<main>` | Automated: `AppLayout.test.js` asserts the skip link is present, targets `#main-content`, and that element is a `<main>` | Pass | `npm test -- --watchAll=false` in `frontend/`: `AppLayout.test.js` green |
| J4 | Visit an unknown URL while signed in, then again while signed out | Signed in: 404 card inside the normal shell with "Go to a page you can access"; signed out: a plain card with "Go to sign in"; neither case redirects away silently | Automated (signed-out case): `NotFound.test.js` | Pass | `npm test -- --watchAll=false` in `frontend/`: `NotFound.test.js` green; signed-in case pending manual test |
| J5 | `curl http://localhost:5000/api/this-route-does-not-exist` | JSON `{ "error": "Not found." }` with status 404, not Express's default HTML 404 | Automated: matrix test "unmatched /api route returns a JSON 404" | Pass | `npm test` in `backend/`: subtest 20 (`unmatched /api route returns a JSON 404`) ok |
| J6 | Click the avatar/name button in the top bar; press Escape; click outside | Opens a menu with name/email/role/job title then My account, Help, Privacy, About, Sign out; Escape closes it and returns focus to the button; a click outside also closes it | Automated (click-open and Escape): `TopBar.test.js` | Pass | `npm test -- --watchAll=false` in `frontend/`: `TopBar.test.js` green; click-outside pending manual test |
| J7 | `GET /api/me/sign-ins` for two different signed-in users who each have sign-in history | Each only ever sees their own rows (time, method, IP), newest first, max 10; 401 signed out | Automated: matrix test "GET /api/me/sign-ins returns only the caller's own rows" | Pass | `npm test` in `backend/`: subtest 18 ok |
| J8 | `GET /api/about` signed in, with and without a published forecast | 200 with `version` (from `backend/package.json`), `data` (first/last consumption month) and `latest_forecast` (id, published date, model, horizon, training range) when published, `null` fields when not; 401 signed out | Automated (200/401 via the route table; 200 shape over real seeded data): matrix `GET /api/about` subtest | Pass | `npm test` in `backend/`: subtest 17 ok (route table), subtest 11 (`permission matrix`) ok overall |
| J9 | Any authenticated request's response headers | `X-Session-Expires-In` (whole seconds, > 0) and `X-Session-Max-Reached` (`"false"` for a fresh session) always present | Automated: matrix test "X-Session-Expires-In / X-Session-Max-Reached response headers" | Pass | `npm test` in `backend/`: subtest 19 ok |
| J10 | Let a session sit idle until under 2 minutes remain | An `alertdialog` appears with a live mm:ss countdown, "Stay signed in" (extends the session without losing page state) and "Sign out" | Automated (dialog content/countdown/Stay signed in, via simulated header state, not real elapsed time): `SessionExpiryWarning.test.js` | Pass | `npm test -- --watchAll=false` in `frontend/`: `SessionExpiryWarning.test.js` green; real elapsed-time run pending manual test |
| J11 | Let a session approach the 8-hour absolute cap | Dialog instead says sessions end after 8 hours with the sign-in-again time, and only an OK button | Automated (via simulated `X-Session-Max-Reached: true`): `SessionExpiryWarning.test.js` | Pass | `npm test -- --watchAll=false` in `frontend/`: `SessionExpiryWarning.test.js` green |
| J12 | Open "My account" from the user menu | Name, email, role, job title (if set), session end time, and a sign-in history table (or an empty state) | pending manual test | — | — |
| J13 | Open "Help" as each role | Only the sections that role's permissions allow (Forecast/Production Planning/Users) are shown, plus sign-in/expiry info and the administrator-contact line | pending manual test | — | — |
| J14 | Open "Privacy" signed in (user menu) and signed out (link on `/login`) | Same content either way: what's stored, why, cookies, third parties, forecast data, audit log, retention — no fabricated facts, no legal claims | pending manual test | — | — |
| J15 | Open "About" (user menu, or the sidebar's "Version 1.0" link) | Loading state, then version/data source/range/latest forecast from `GET /api/about`; an error state if the request fails | pending manual test | — | — |
| J16 | `npm test` in `backend/`; `npm test -- --watchAll=false` and `npm run build` in `frontend/` | All pass, including the pre-existing `frontend/src/App.test.js` (previously blocked by a Jest/react-router-dom module-resolution error — see README's Known Limitations) | Ran all three: backend 170/170 pass (0 fail, 0 skipped — `TEST_DATABASE_URL` was configured); frontend 13/13 pass across 5 suites; `npm run build` compiled successfully | Pass | Fixed via `frontend/package.json`'s new `jest.moduleNameMapper` (maps `react-router/dom` to its real file, which Jest 27's resolver can't reach through react-router's `exports` map) plus a `TextEncoder`/`TextDecoder` polyfill in `setupTests.js` |

**Note:** J2, J4 (signed-in case), J6 (click-outside), J12, J13, J14, J15 need a
running backend + frontend with a real signed-in session (Google sign-in) to
verify visually — not run in this session per the task's instructions (no
servers were started, no `.env` touched). Everything else above was actually
executed as part of this change.

## Part K - Demand by district (Module 4)

District-level split of the published forecast (`GET /api/distribution`,
`backend/distribution.js`) and the new "Demand by district" page, for
Production Planners (`distribution:view`) only. All share/allocation/swing
math runs on the server; the frontend only renders what the API returns.
Automated: `backend/test/distribution.test.js` (pure functions),
`backend/test/permissions.matrix.test.js` (`GET /api/distribution` added to
the route table), and `frontend/src/DemandByDistrict.test.js`.

| Requirement | Input | Expected | Actual | Pass/Fail | Evidence |
|---|---|---|---|---|---|
| K1 | `pickShareYears(rows, month)` for a calendar month with data in several years | Returns exactly the 3 most recent years that actually have data for that month, most recent first (fewer than 3 if the data doesn't go back that far) | Automated: `distribution.test.js` "picks the 3 most recent years that actually have data for that calendar month" | Pass | `npm test` in `backend/`: 184/184 pass |
| K2 | `buildDistrictBreakdown(...)` over a constructed fixture with several districts | `share_pct` across districts sums to exactly 100% (rounding drift absorbed by the largest district) | Automated: `distribution.test.js` "shares sum to exactly 100% and allocations sum to exactly the plan total" | Pass | `npm test` in `backend/`: 184/184 pass |
| K3 | Same fixture, with an active plan's `chosen_m3` set | `allocation_m3` across districts sums to exactly the plan total; `null` for every district when there is no active plan for that month | Automated: `distribution.test.js` "...sum to exactly the plan total" and "allocation is null for every district when there is no active plan" | Pass | `npm test` in `backend/`: 184/184 pass |
| K4 | A district whose share grew then shrank year-over-year | `share_change_pts` is positive for the grown year-pair and negative for the shrunk one, using the two most recent years with data | Automated: `distribution.test.js` "share change is positive when a district grew and negative when it shrank" | Pass | `npm test` in `backend/`: 184/184 pass |
| K5 | `computeSeasonalSwing(rows, districts)` over a fixture with one district having a clear seasonal high/low | Returns that district, its high/low ratio, and the correct high/low calendar months (computed from the data, not hard-coded); returns `null` with no districts | Automated: `distribution.test.js` "picks the district with the largest high/low ratio, and the right months" and "returns null when there are no districts" | Pass | `npm test` in `backend/`: 184/184 pass |
| K6 | `GET /api/distribution` as Production Planner, Admin, Commercial Analyst, and signed out | 200 / 403 / 403 / 401 respectively | Automated: matrix test route table entry for `GET /api/distribution` | Pass | `npm test` in `backend/`: 184/184 pass |
| K7 | Load `/demand-by-district` as a Production Planner with sample API data | KPI cards show the largest district, districts-covered count, and the biggest seasonal swing district; table and bars reflect the first forecast month by default | Automated: `DemandByDistrict.test.js` "renders the first forecast month with its KPIs" | Pass | `npm test -- --watchAll=false` in `frontend/`: `DemandByDistrict.test.js` green |
| K8 | Change the month selector to a month with no active plan | KPI cards and table update for the new month; "No production plan saved for this month. Go to Production Planning." note appears; plan KPI shows "No plan saved" | Automated: `DemandByDistrict.test.js` "changing the month updates the KPI cards and shows the no-plan note" | Pass | `npm test -- --watchAll=false` in `frontend/`: `DemandByDistrict.test.js` green |
| K9 | Click the "Forecast" column header in the table | Row order reverses (desc → asc) | Automated: `DemandByDistrict.test.js` "sorting the table by a column reverses the row order" | Pass | `npm test -- --watchAll=false` in `frontend/`: `DemandByDistrict.test.js` green |
| K10 | Open "Demand by district" as Admin or Commercial Analyst | The normal access-denied view (declarative `requiredPermission`, same as other permission-gated pages), not a custom page | pending manual test | — | — |
| K11 | On the page, export the table as CSV | Downloaded file's rows match the visible table, including the totals row | pending manual test | — | — |
| K12 | View the page at 375px wide | No horizontal page scroll; the table scrolls within its own card if needed; bar/badge information is also conveyed in text, not colour alone | pending manual test | — | — |
| K13 | Open "Help" as a Production Planner | A "Demand by district" section explains the ~5% district-mismatch rate, that districts aren't real supply zones, and that one loss rate is applied to every district | pending manual test (section renders per automated Help tests from Part J, but this session's test run didn't re-verify the new section's exact copy against a live Help page) | — | — |
| K14 | `npm test` in `backend/`; `npm test -- --watchAll=false` and `npm run build` in `frontend/` | All pass | Backend 184/184 pass, 0 skipped (`TEST_DATABASE_URL` configured); frontend 19/19 pass across 6 suites; `npm run build` compiled successfully | Pass | Ran all three this session |

**Note:** K10, K11, K12 need a running backend + frontend with a real
signed-in session to verify visually — not run in this session (no servers
were started, no `.env` touched). K13 is a text-content check against a live
page render; everything else above was actually executed as part of this
change.

## Part L - Revenue estimate (Module 5)

Billed-revenue estimate split by (district, subscriber-type) cell, priced
through the latest published tariff (`GET /api/revenue`,
`backend/revenue.js`), plus the new wastewater price column
(`008_tariff_wastewater.sql`, `database/load_tariffs.py`) and the "Revenue
estimate" page, for Commercial Analysts (`revenue:view`) only. All
volume-split, tariff-lookup and tiered-billing math runs on the server; the
frontend only renders what the API returns. Migration 008 and the loader
re-run were **not** executed this session — the user runs those themselves
after a backup, per the task's instructions. Automated:
`backend/test/revenue.test.js` (pure functions),
`backend/test/permissions.matrix.test.js` (`GET /api/revenue` added to the
route table, migration 008 added to the test database's migration list),
and `frontend/src/RevenueEstimate.test.js`.

| Requirement | Input | Expected | Actual | Pass/Fail | Evidence |
|---|---|---|---|---|---|
| L1 | `priceThroughBands(10.4, bands, 'waterPrice'/'wastewaterPrice')` for KONUT's exact July-2024 bands (water 16.74/32.35/41.37/77.46; wastewater 8.36/16.17/20.67/38.72) | Hand-calculated totals: water ₺277.61, wastewater ₺138.73 (each band only charges for the m³ inside it) | Automated: `revenue.test.js` "hand-calculated KONUT case at 10.4 m3/subscriber/month" | Pass | `npm test` in `backend/`: 200/200 pass |
| L2 | `priceThroughBands(3, bands, 'waterPrice')` (usage entirely inside the first band) | Charged at the first band's rate only, not spilled into the second band's higher rate | Automated: `revenue.test.js` "only charges for the m3 inside each band, not the whole total at one rate" | Pass | `npm test` in `backend/`: 200/200 pass |
| L3 | `buildTariffCatalog(tariffRows)` with one tariff_type having two different prices for the same band | That tariff_type is flagged `ambiguous: true`; an unambiguous tariff_type is `ambiguous: false` | Automated: `revenue.test.js` "flags a tariff_type with differing prices in the same band as ambiguous" | Pass | `npm test` in `backend/`: 200/200 pass |
| L4 | `buildCellVolumes(...)` over a constructed (district, subscriber_type) fixture | Cell shares sum to exactly the city forecast volume; a cell's share matches its hand-computed fraction of total consumption | Automated: `revenue.test.js` "shares split the city forecast across every (district, subscriber_type) cell" | Pass | `npm test` in `backend/`: 200/200 pass |
| L5 | `buildRevenueBreakdown(...)` with one unmapped, one ambiguous, and one zero-subscriber (volume > 0) cell alongside a normally-priced cell | The three problem cells are reported `not_priced_reason` (`unmapped`/`ambiguous`/`no_subscribers`) with ₺0 charged; the normal cell prices normally | Automated: `revenue.test.js` "unmapped, ambiguous and zero-subscriber cells are not priced" | Pass | `npm test` in `backend/`: 200/200 pass |
| L6 | Same fixture, comparing a priced cell's low/mid/high totals | `total.low <= total.mid <= total.high` holds | Automated: `revenue.test.js` "low <= mid <= high for a priced cell" | Pass | `npm test` in `backend/`: 200/200 pass |
| L7 | Same fixture's month-level totals | `not_priced_volume_m3`/`not_priced_pct` exactly account for the volume of every flagged cell | Automated: `revenue.test.js` "not-priced volume and percentage account for every unpriced cell" | Pass | `npm test` in `backend/`: 200/200 pass |
| L8 | `buildGroupBreakdown(...)` over the same priced cells | Summing every customer_group's `total_try` equals the month's `totals.total.mid` exactly | Automated: `revenue.test.js` "group totals sum to exactly the month total" | Pass | `npm test` in `backend/`: 200/200 pass |
| L9 | `GET /api/revenue` as Commercial Analyst, Admin, Production Planner, and signed out | 200 / 403 / 403 / 401 respectively | Automated: matrix test route table entry for `GET /api/revenue` | Pass | `npm test` in `backend/`: 200/200 pass |
| L10 | Load `/revenue` as a Commercial Analyst with sample API data | KPI cards show expected revenue (with low–high), water charge, wastewater charge, and the not-priced percentage, for the first forecast month by default | Automated: `RevenueEstimate.test.js` "renders the first forecast month with its KPIs" | Pass | `npm test -- --watchAll=false` in `frontend/`: `RevenueEstimate.test.js` green |
| L11 | Change the month selector | KPI cards update to the newly selected month's figures | Automated: `RevenueEstimate.test.js` "changing the month updates the KPI cards" | Pass | `npm test -- --watchAll=false` in `frontend/`: `RevenueEstimate.test.js` green |
| L12 | Open the "Not priced" KPI card's info tip | Shows the not-priced percentage and, on request, the reasons (e.g. "no tariff mapping for this subscriber type") with their volume and cell count | Automated: `RevenueEstimate.test.js` "the not-priced card shows its percentage and reasons" | Pass | `npm test -- --watchAll=false` in `frontend/`: `RevenueEstimate.test.js` green |
| L13 | Run migration `008_tariff_wastewater.sql` on a real database, then re-run `database/load_tariffs.py` | `tariffs.wastewater_price_per_m3` is populated from the source file's `ATIKSU_FIYATI` column (0 stays 0, e.g. "ATIKSU BEDELSİZ" types); the loader's ambiguity report also flags groups with differing wastewater prices | pending manual test (migration/loader intentionally not run this session — the user runs them after a backup) | — | — |
| L14 | Open "Revenue estimate" as Admin or Production Planner | The normal access-denied view (declarative `requiredPermission`), not a custom page | pending manual test | — | — |
| L15 | On the page, export the district × customer-group detail as CSV | Downloaded file's rows match the API's `detail` list for the selected month | pending manual test | — | — |
| L16 | View the page at 375px wide | No horizontal page scroll; tables scroll within their own card if needed; the chart's selected-month bar is distinguishable by more than colour alone (the legend/tooltip name it) | pending manual test | — | — |
| L17 | Open "Help" as a Commercial Analyst | A "Revenue estimate" section states the figures are a lower bound, at July 2024 prices, excluding taxes | pending manual test (section renders per automated Help coverage elsewhere, but this session's run didn't re-verify the new section's exact copy against a live Help page) | — | — |
| L18 | Open the "Tariff in use" table | Housing and workplace bands shown with water and wastewater ₺/m³, matching the API's `tariffs_in_use`, dated to the tariff's actual `valid_from` | pending manual test (depends on real tariff data, which depends on L13) | — | — |
| L19 | `npm test` in `backend/`; `npm test -- --watchAll=false` and `npm run build` in `frontend/` | All pass | Backend 200/200 pass, 0 skipped (`TEST_DATABASE_URL` configured, migrations through 008 applied); frontend 22/22 pass across 7 suites; `npm run build` compiled successfully, no warnings | Pass | Ran all three this session |

**Note:** L13, L14, L15, L16, L17, L18 need a running backend + frontend
with a real signed-in session, and L13/L18 additionally need migration 008
and a loader re-run against real tariff data — none of this was run in this
session (no servers were started, no migration or loader was run, no `.env`
touched). Everything else above was actually executed as part of this
change.

## Part M - Overview (Module 6)

The role-based landing page after sign-in (`GET /api/overview`,
`backend/overview.js`) and the new "Overview" page, for every signed-in
user — no permission gate of its own, but each section inside it only
appears for a permission the signed-in user already has elsewhere
(`forecast:view`, `plan:view`, `distribution:view`, `revenue:view`,
`user:manage`). All of the section data and alert-threshold logic runs on
the server, reusing `backend/distribution.js`/`backend/revenue.js`/the
existing Production Planning helpers rather than re-implementing any of
that maths. Automated: `backend/test/overview.test.js` (pure alert-rule
functions), `backend/test/permissions.matrix.test.js` (`GET /api/overview`
added to the route table, plus a dedicated per-role section-content
check), `frontend/src/Overview.test.js`, and
`frontend/src/PostLoginRedirect.test.js`.

| Requirement | Input | Expected | Actual | Pass/Fail | Evidence |
|---|---|---|---|---|---|
| M1 | `productionAlerts({ daysOfCover: 30, ... })` / `daysOfCover: 29` / `daysOfCover: 15` / `daysOfCover: 14` | 30 and 15 raise no alert yet (not strictly below the threshold); 29 is a `warning`; 14 is an `alert`, never both at once | Automated: `overview.test.js` the four "days of cover" boundary tests | Pass | `npm test` in `backend/`: 234/234 pass |
| M2 | `productionAlerts({ daysSinceStock: 30 })` / `daysSinceStock: 31` / `daysSinceStock: null` | 30 days is still fresh (no alert); 31 days and "never recorded" (`null`) both raise the stale-stock `info` alert | Automated: `overview.test.js` the three "stock recorded" boundary tests | Pass | `npm test` in `backend/`: 234/234 pass |
| M3 | `revenueAlerts({ notPricedPct: 5 })` / `notPricedPct: 5.1` | Exactly 5% raises no warning; 5.1% does; the July-2024-tariff `info` alert is always present | Automated: `overview.test.js` the three `revenueAlerts` tests | Pass | `npm test` in `backend/`: 234/234 pass |
| M4 | `userManageAlerts({ failedAttempts: 0 })` / `failedAttempts: 1`; `daysSinceEmergencyLogin: 30` / `31` | Zero failed attempts raises nothing; one does; an emergency sign-in exactly 30 days ago still warns, 31 days ago no longer does | Automated: `overview.test.js` the failed-attempt and emergency-login boundary tests | Pass | `npm test` in `backend/`: 234/234 pass |
| M5 | `GET /api/overview` as Admin, Production Planner, Commercial Analyst, and signed out | 200 / 200 / 200 / 401 respectively (every active role gets 200 — only the sections inside differ) | Automated: matrix test route table entry for `GET /api/overview` | Pass | `npm test` in `backend/`: 234/234 pass |
| M6 | Same request, comparing each role's response body | Admin's body has `forecast`/`users` but not `production`/`distribution`/`revenue`; Production Planner's has `forecast`/`production`/`distribution` but not `users`/`revenue`; Commercial Analyst's has `forecast`/`revenue` but not `production`/`distribution`/`users` | Automated: `permissions.matrix.test.js` "GET /api/overview: each role sees only the sections its own permissions unlock" | Pass | `npm test` in `backend/`: 234/234 pass |
| M7 | Load `/overview` as Admin, Production Planner, and Commercial Analyst with sample API data | Admin sees only admin KPIs/sections (active users, recent activity); Production Planner sees only production KPIs/sections (days of stock, largest district, the 12-month forecast chart); Commercial Analyst sees only revenue KPIs/sections (expected revenue, not-priced %, the 12-month revenue chart) | Automated: `Overview.test.js`, one test per role | Pass | `npm test -- --watchAll=false` in `frontend/`: `Overview.test.js` green |
| M8 | An alert in the "Needs your attention" list | Rendered as a link (not just status text) to the page that fixes it, with an icon that differs by level (info/warning/alert), never colour alone | Automated: `Overview.test.js` "an Admin session shows only admin sections" (checks the alert's link target) | Pass | `npm test -- --watchAll=false` in `frontend/`: `Overview.test.js` green |
| M9 | A role with zero alerts | A calm "Nothing needs your attention." state, not an error-styled one | Automated: `Overview.test.js` "a Production Planner session shows only production sections" | Pass | `npm test -- --watchAll=false` in `frontend/`: `Overview.test.js` green |
| M10 | Signing in (Google or emergency) | Lands on `/overview`, regardless of role | Automated: `PostLoginRedirect.test.js` "signing in (emergency login) lands on /overview, regardless of role" | Pass | `npm test -- --watchAll=false` in `frontend/`: `PostLoginRedirect.test.js` green |
| M11 | A signed-in visit straight to an existing deep link (e.g. `/demand-by-district`) | Renders that page directly; is never redirected to `/overview` | Automated: `PostLoginRedirect.test.js` "a signed-in deep link to another page is not redirected to /overview" | Pass | `npm test -- --watchAll=false` in `frontend/`: `PostLoginRedirect.test.js` green |
| M12 | Click a "no plan saved" alert's link (`/production-planning?month=YYYY-MM-01`) | Opens straight to that month's detail panel on Production Planning, then drops the query param | pending manual test (the `?month=` deep-link handling in `ProductionPlanning.js` wasn't covered by an automated test this session) | — | — |
| M13 | Open the "How alerts work" info tip | Lists the actual threshold values from the API response (`thresholds`), not a second hardcoded copy | pending manual test | — | — |
| M14 | Open "Help" as any role | A plain-language "Overview" section is present (no permission gate) | pending manual test (section renders per automated Help coverage elsewhere, but this session's run didn't re-verify the new section's exact copy against a live Help page) | — | — |
| M15 | View the page at 375px wide | No horizontal page scroll; charts/tables stay inside their own card | pending manual test | — | — |
| M16 | `npm test` in `backend/`; `npm test -- --watchAll=false` and `npm run build` in `frontend/` | All pass | Backend 234/234 pass, 0 skipped (`TEST_DATABASE_URL` configured); frontend 32/32 pass across 10 suites; `npm run build` compiled successfully, no warnings | Pass | Ran all three this session |

**Note:** M12, M13, M14, M15 need a running backend + frontend with a real
signed-in session to verify visually — not run in this session (no servers
were started, no `.env` touched). Everything else above was actually
executed as part of this change.

## Part N - Revenue scenarios (Module 5b)

"What happens to revenue if prices change?" — up to two live, unsaved
price-change scenarios compared against the Revenue estimate baseline
(`POST /api/revenue/scenario`, `backend/revenueScenarios.js`), for
Commercial Analysts (`revenue:view`) only. A scenario can scale every
tariff band uniformly or change only housing/workplace bands per band; an
optional constant-elasticity demand-response step models usage changing
with price. All of this reuses `backend/revenue.js`'s own tariff and
tiered-billing functions (`priceThroughBands`, `buildRevenueBreakdown`,
`sumField`) rather than duplicating that maths — the only new logic is
the price-scaling and elasticity steps themselves. Automated:
`backend/test/revenueScenarios.test.js` (pure functions),
`backend/test/permissions.matrix.test.js` (`POST /api/revenue/scenario`
added to the route table), and `frontend/src/RevenueScenarios.test.js`.

| Requirement | Input | Expected | Actual | Pass/Fail | Evidence |
|---|---|---|---|---|---|
| N1 | `validateScenarioRequest` with 3 scenarios / an out-of-range `uniform_pct` / an out-of-range `elasticity` / a malformed `steps` shape | Each is rejected with a field-level error (`scenarios`, `scenarios[0].uniform_pct`, `scenarios[0].elasticity`, `scenarios[0].steps`) | Automated: `revenueScenarios.test.js` the four validation tests | Pass | `npm test` in `backend/`: 258/258 pass |
| N2 | `buildScenarioMonth(...)` with `mode: 'uniform', uniform_pct: 0, elasticity: 0` | Reproduces the baseline month's water/wastewater/total totals exactly | Automated: `revenueScenarios.test.js` "zero % change and elasticity 0 reproduces the baseline exactly" | Pass | `npm test` in `backend/`: 258/258 pass |
| N3 | `buildScenarioMonth(...)` with `mode: 'uniform', uniform_pct: 10, elasticity: 0` | Total revenue is exactly the baseline total × 1.1 (rounded to the cent); priced volume is unchanged (no demand response) | Automated: `revenueScenarios.test.js` "a uniform +10% scenario with elasticity 0 gives exactly +10% revenue, with volume unchanged" | Pass | `npm test` in `backend/`: 258/258 pass |
| N4 | `rescoreCell(...)` with a scenario price +20% and `elasticity: -0.35`, in scope | The price ratio is > 1, and the new volume is lower than the baseline volume | Automated: `revenueScenarios.test.js` "elasticity -0.35 with a price rise lowers volume" | Pass | `npm test` in `backend/`: 258/258 pass |
| N5 | `rescoreCell(...)` for a cell outside the elasticity scope, under a +50% scenario price | Volume is unchanged from baseline, but the cell is still re-priced at the new (higher) rate | Automated: `revenueScenarios.test.js` "a cell outside the elasticity scope keeps its baseline volume even under a price change" | Pass | `npm test` in `backend/`: 258/258 pass |
| N6 | `buildScenarioMonth(...)` with `mode: 'per_step'`, housing/workplace steps set, a third tariff type present | The third tariff type's revenue and volume are byte-identical to the baseline; housing's revenue changes | Automated: `revenueScenarios.test.js` "per_step changes touch only housing/workplace bands; every other tariff type is byte-identical to baseline" | Pass | `npm test` in `backend/`: 258/258 pass |
| N7 | `scaleTariffCatalog(...)` in per_step mode, for a tariff type that isn't housing or workplace | The returned catalog entry is the exact same object reference as the baseline catalog's | Automated: `revenueScenarios.test.js` "per_step mode leaves a third tariff type as the exact same object" | Pass | `npm test` in `backend/`: 258/258 pass |
| N8 | `buildScenarioMonth(...)` with a price change and elasticity, compared to the baseline's not-priced figures | `not_priced_pct`/`not_priced_volume_m3` are carried over unchanged from the baseline — a price/demand-response change never affects which cells are priceable | Automated: `revenueScenarios.test.js` "the not-priced share is carried over unchanged from the baseline" | Pass | `npm test` in `backend/`: 258/258 pass |
| N9 | `POST /api/revenue/scenario` as Commercial Analyst, Admin, Production Planner, and signed out | 200 / 403 / 403 / 401 respectively | Automated: matrix test route table entry for `POST /api/revenue/scenario` | Pass | `npm test` in `backend/`: 258/258 pass |
| N10 | Load `/revenue/scenarios` as a Commercial Analyst with sample API data | The baseline-vs-scenario table shows the first forecast month's baseline and Scenario A totals | Automated: `RevenueScenarios.test.js` "renders the first forecast month with the baseline-vs-scenario table" | Pass | `npm test -- --watchAll=false` in `frontend/`: `RevenueScenarios.test.js` green |
| N11 | Change the month selector | The baseline-vs-scenario table updates to the newly selected month's figures | Automated: `RevenueScenarios.test.js` "changing the month updates the table figures" | Pass | `npm test -- --watchAll=false` in `frontend/`: `RevenueScenarios.test.js` green |
| N12 | The server returns a 400 with a field error for `scenarios[0].uniform_pct` | The error message appears inline, next to that input, not just as a toast | Automated: `RevenueScenarios.test.js` "a 400 validation error from the server is shown inline at the relevant input" | Pass | `npm test -- --watchAll=false` in `frontend/`: `RevenueScenarios.test.js` green |
| N13 | Switch Scenario A to per-step mode and click "May 2025 İzmir change" | Housing and workplace step inputs fill with 0/15/25/35 | Automated: `RevenueScenarios.test.js` "the May 2025 İzmir change preset fills in per-step housing and workplace values" | Pass | `npm test -- --watchAll=false` in `frontend/`: `RevenueScenarios.test.js` green |
| N14 | Open "Revenue scenarios" as Admin or Production Planner | The normal access-denied view (declarative `requiredPermission`), not a custom page | pending manual test | — | — |
| N15 | Enable scenario B and compare it against Scenario A and the baseline | The side-by-side table and 12-month chart both show three series, each named and distinguishable by more than colour alone | pending manual test | — | — |
| N16 | Open the "How are scenarios calculated?" info tip, on both this page and the Demand by district page, near the viewport edges | Opens below the icon, stays fully inside the viewport at 375px, closes on Escape | pending manual test | — | — |
| N17 | View the page at 375px wide | No horizontal page scroll; tables scroll within their own card if needed | pending manual test | — | — |
| N18 | Open "Help" as a Commercial Analyst | A "Revenue scenarios" section explains the method, the elasticity source, and the same lower-bound caveat as Revenue estimate | pending manual test | — | — |
| N19 | `npm test` in `backend/`; `npm test -- --watchAll=false` and `npm run build` in `frontend/` | All pass | Backend 258/258 pass, 0 skipped (`TEST_DATABASE_URL` configured); frontend 46/46 pass across 12 suites; `npm run build` compiled successfully, no warnings | Pass | Ran all three this session |

**Note:** N14-N18 need a running backend + frontend with a real signed-in
session to verify visually — not run in this session (no servers were
started, no `.env` touched, no migration or SQL run against any
database). Everything else above was actually executed as part of this
change.
