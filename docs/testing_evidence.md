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
