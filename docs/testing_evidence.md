# Sprint 2 Testing Evidence

This document records the tests performed during Sprint 2 implementation of the
Water Demand Forecasting system: the Prophet/ARIMA forecasting pipeline, the
PostgreSQL data layer, the Node/Express backend API, and the React frontend
(login, dashboard, routing).

**Note on test methodology:** the project does not yet have an automated unit
test suite for the backend or ML scripts. Most entries below are manual
verification/integration checks performed during implementation — running the
actual script or endpoint and inspecting its output — rather than assertions
in a test framework. Where an automated test exists (the frontend's CRA test
suite), it is reported separately and labeled as such.

Status legend: ✅ Pass · ❌ Fail / Issue Found · ⚠️ Pass with caveat

---

## 1. Forecasting Model (`ml/`)

| # | Test Name | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| 1.1 | Save trained Prophet model with joblib | Model object is serialized to `G:\My Drive\water-demand-forecasting\models\prophet_model.pkl` after `model.fit(train)` | File written successfully; confirmed by script completing and printing save path | ✅ |
| 1.2 | Auto-create missing model output directory | `os.makedirs(..., exist_ok=True)` creates the `models` folder if absent, without erroring if it already exists | Script ran without `FileNotFoundError` on repeated runs | ✅ |
| 1.3 | Full `forecast.py` pipeline run (80/20 split, MAE/RMSE) | Script loads 120 records, splits 96/24, trains Prophet, prints MAE and RMSE | MAE: 401,104.74 m³, RMSE: 457,897.28 m³ | ✅ |
| 1.4 | 6-month forecast reflects *future* dates, not historic test window | `make_future_dataframe` continues from the retrained model, giving dates after the last known data point | **Issue found:** initial version forecasted 2023-01 to 2023-06 (inside the historic test window) because the 6-month forecast used the 80/20-split model instead of a model retrained on all data. **Fixed:** added a final retrain step on all 120 records; forecast now correctly shows 2025-01 to 2025-06 | ✅ (after fix) |
| 1.5 | MAPE calculation added to evaluation | `MAPE = mean(\|actual - pred\| / actual) * 100` printed alongside MAE/RMSE | MAPE: 1.57% | ✅ |
| 1.6 | Prophet cross-validation (`initial='840 days'`, `period='180 days'`, `horizon='180 days'`) | `cross_validation` + `performance_metrics` run without error, mean MAE/RMSE printed | Completed in ~5 minutes across 11 folds. Mean MAE: 190,087.24 m³, Mean RMSE: 227,574.28 m³ | ✅ |
| 1.7 | `ml/arima_model.py` — DB connection and data load via `.env` | Script connects using `.env` credentials and loads `date`, `consumption_m3` ordered by date | 120 records loaded, date range 2015-01-01 to 2024-12-01 printed correctly | ✅ |
| 1.8 | `forecast_with_regressors.py` — load data with regressor columns | Loads `date`, `consumption_m3`, `temperature`, `precipitation`, `population` from DB | First 5 rows printed correctly with all 5 columns populated | ✅ |
| 1.9 | `forecast_with_regressors.py` — rename columns + 80/20 temporal split | Columns renamed to `ds`/`y`; split preserves chronological order | Training: 96 records, Testing: 24 records (matches `forecast.py`) | ✅ |
| 1.10 | `forecast_with_regressors.py` — Prophet model fit with 3 regressors | Model trains with `temperature`, `precipitation`, `population` added via `add_regressor()` before `fit()` | Model fit completed without error (cmdstanpy chain finished) | ✅ |
| 1.11 | `forecast_with_regressors.py` — forecast + evaluation vs. baseline | Predict on test period using actual regressor values; compute MAE/RMSE/MAPE; compare to baseline (401,104 / 457,897) | MAE: 401,775.35 m³ (+0.17%), RMSE: 459,879.23 m³ (+0.43%), MAPE: 1.58%. **Finding:** regressors did not improve accuracy over the baseline — likely redundant with Prophet's existing yearly seasonality term | ✅ (experiment completed; no accuracy gain found) |
| 1.12 | `ml/forecast_api.py` — lightweight variant without cross-validation | Produces identical MAE/RMSE/MAPE/forecast output to `forecast.py` but skips the CV step, for faster API use | Output matched `forecast.py`'s evaluation section exactly; CV section correctly omitted | ✅ |

## 2. Database (`database/`)

| # | Test Name | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| 2.1 | `load_data.py` — load temperature/precipitation/population into `consumption_data` | CSV columns `Sicaklik_Ort`, `Yagis_mm`, `Nufus` mapped to `temperature`, `precipitation`, `population` and inserted | Existing table columns already present (no schema change needed); confirmed via `information_schema.columns` | ✅ |
| 2.2 | `load_data.py` — delete-then-reload behavior | All existing rows deleted before reinserting from CSV | Row count unchanged at 120 after reload; 0 `NULL`s across the 3 new columns; spot-checked first row (2015-01-01: temp 10.6, precip 105.6, pop 4,279,677) and last row (2024-12-01: temp 11.2, precip 101.5, pop 4,535,123) | ✅ |
| 2.3 | `database/seed_users.py` — seed manager and admin users with bcrypt hashes | Two users inserted into `users` with bcrypt-hashed passwords; safe to re-run (`ON CONFLICT (email) DO NOTHING`) | Both rows confirmed present with correct `name`/`email`/`role`; password column is a 60-character `$2b$`-prefixed bcrypt hash (not plaintext) for both | ✅ |
| 2.4 | `.env`-based DB credentials (replacing hardcoded values) | `load_data.py`, `forecast.py`, `arima_model.py`, `forecast_with_regressors.py`, and `backend/index.js` all read DB credentials from `.env` instead of hardcoded strings | All scripts ran successfully against the live DB using `.env`-sourced credentials | ✅ |

## 3. Backend API (`backend/`)

| # | Test Name | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| 3.1 | PostgreSQL connection pool (`pg.Pool`) using `.env` | Pool connects and can query the DB | Standalone test connected and returned `consumption_data` row count of 120 | ✅ |
| 3.2 | `POST /api/auth/login` — missing email/password | Returns `400` with a descriptive error | `400 {"error":"Email and password are required"}` | ✅ |
| 3.3 | `POST /api/auth/login` — unknown email | Returns `401` with a generic message (no email enumeration) | `401 {"error":"Invalid email or password"}` | ✅ |
| 3.4 | `POST /api/auth/login` — known email, wrong password | Returns `401` with the same generic message | `401 {"error":"Invalid email or password"}` (tested against seeded `manager@water.com`) | ✅ |
| 3.5 | `POST /api/auth/login` — correct credentials | Returns `200` with a signed JWT and user info, no password field | `200` with valid JWT (`user_id`, `email`, `role` payload, 1h expiry) and `user: {user_id, name, email, role}` | ✅ |
| 3.6 | `GET /api/forecast` — no token | Returns `401` | `401 {"error":"No token provided"}` | ✅ |
| 3.7 | `GET /api/forecast` — invalid/malformed token | Returns `403` | `403 {"error":"Invalid or expired token"}` | ✅ |
| 3.8 | `GET /api/forecast` — valid token, full `forecast.py` (with CV) | Returns `200` with parsed `mae`, `rmse`, `mape`, 6-month `forecast` array | `200`; values matched script output exactly (MAE 401,104.74, RMSE 457,897.28, MAPE 1.57, 6 forecast rows) — response took ~5–6 minutes due to cross-validation | ✅ |
| 3.9 | `GET /api/forecast` — switched to `forecast_api.py` (no CV) for performance | Same response shape and values, faster response time | `200` in ~17.3 seconds (down from ~5–6 minutes), identical MAE/RMSE/MAPE/forecast values | ✅ |
| 3.10 | Merge conflict resolution — both login and forecast routes coexist | After merging `develop` (login route) into the forecast-route branch, both routes function correctly | Full re-test after merge: login missing-fields → 400; login valid creds → 200 + JWT; forecast no-token → 401; forecast with that same login-issued JWT → 200 with correct data | ✅ |

## 4. Frontend (`frontend/`)

| # | Test Name | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| 4.1 | CRA automated test suite (`App.test.js`) | Default/existing test suite passes | **Failed to run** (not just a failed assertion): `npx react-scripts test --watchAll=false` reports `Cannot find module 'react-router/dom' from 'node_modules/react-router-dom/dist/index.js'`. Jest's module resolver cannot resolve `react-router-dom`'s package `exports` the way webpack does for `react-scripts build`, so `App.test.js` errors out before any assertion runs (also, separately, the test's own assertion — a "Learn React" link — is stale, since `App.js` no longer renders that text). Result: `Test Suites: 1 failed, 1 total`, `Tests: 0 total` | ❌ |
| 4.2 | `Login.js` — build/compile check | Component compiles cleanly under `react-scripts build` | `Compiled successfully` | ✅ |
| 4.3 | `App.js` — React Router setup (`/` → redirect to `/login`, `/login` route) | Builds cleanly with `react-router-dom` routes defined | `Compiled successfully` | ✅ |
| 4.4 | `Dashboard.js` + `/dashboard` route — token-gate and logout | Redirects to `/login` if no token present; logout clears token and redirects | Build compiled successfully; logic reviewed (not manually clicked through in a browser) | ⚠️ *(build-verified only, no manual browser walkthrough)* |
| 4.5 | `Dashboard.js` — fetch and render forecast data | Fetches `/api/forecast` with stored JWT; shows loading message; renders MAE/RMSE/MAPE cards and 6-month table on success | Build compiled successfully (+346 B gzipped). Rendering logic (`toLocaleString()` formatting, table row mapping) simulated against a real `/api/forecast` response with no runtime errors — correct output (e.g. "401,104.74 m3", 6 dated rows) | ⚠️ *(simulated against live API data, not a manual browser test)* |
| 4.6 | Dashboard CSS styling (metric cards, forecast table) | Styles compile without breaking the build | `Compiled successfully`, CSS bundle +283 B gzipped | ✅ *(visual appearance not manually verified in-browser)* |

**CRA test suite result (`npx react-scripts test --watchAll=false`):**

```
FAIL src/App.test.js
  ● Test suite failed to run

    Cannot find module 'react-router/dom' from 'node_modules/react-router-dom/dist/index.js'

Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
```

This is a Jest/`react-router-dom` v7 module-resolution incompatibility in
this CRA 5 setup (webpack resolves the package's `exports` field fine for
production builds, Jest's resolver does not) — it blocks the test file from
running at all, independent of the test's own stale assertion. Needs a fix in
Sprint 3 (e.g. a Jest `moduleNameMapper`/resolver config, or updating the test
itself once addressed) before this suite is meaningful again.

## 5. Security & Configuration

| # | Test Name | Expected Result | Actual Result | Status |
|---|---|---|---|---|
| 5.1 | `.env` excluded from git tracking | `.env` does not appear in `git status` and is matched by `.gitignore` | `git check-ignore -v .env` confirmed it is ignored (`.gitignore:2:.env`) | ✅ |
| 5.2 | Git history secret scan for hardcoded DB password | No plaintext password should exist in commit history | **Issue found:** `password="4407"` is committed in `ml/forecast.py` (commit `c040ed7`) and `database/load_data.py` (commit `14ea951`), and both commits are already pushed to `origin/main` on GitHub | ❌ *(remediation: rotate the DB password; history rewrite optional)* |
| 5.3 | JWT secret loads correctly from `.env` in the backend | `process.env.JWT_SECRET` is populated when the server starts from `backend/` | **Issue found during testing:** `dotenv.config()` without an explicit path looked for `.env` in `backend/` (cwd) instead of the project root, so `JWT_SECRET` was `undefined`. **Fixed:** pointed `dotenv.config({ path: ... })` at the root `.env` explicitly | ✅ *(after fix)* |

---

## Known environment issue (not a code defect)

During backend testing, `kill $!` / `kill <pid>` from Git Bash on Windows did
not reliably terminate `node.exe` processes, leaving stale servers bound to
port 5000 that answered some test requests with outdated code/config,
producing a few spurious `403` results. This was a local testing-tool quirk,
not a bug in the application; `taskkill //PID <pid> //F` (using the real PID
from `netstat -ano`) was used instead, and all affected tests were re-run and
confirmed passing against a verified clean process.

## Summary

- **Pass:** 31
- **Fail / Issue found:** 2 (CRA test suite broken by a `react-router-dom`/Jest module resolution error; hardcoded password in git history — both documented above with remediation notes)
- **Pass with caveat:** 2 (frontend items verified by build + simulated logic, not manual in-browser QA)

Outstanding follow-ups for Sprint 3: rotate the exposed DB password, fix the
Jest/`react-router-dom` module resolution issue blocking `App.test.js` (and
update its stale assertion once it can run), add a real automated test suite
(none currently exists beyond the default CRA scaffold), and perform manual
in-browser QA of the login → dashboard flow.
