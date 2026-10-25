# water-demand-forecasting

## Overview
This project develops an integrated water demand forecasting system using the Prophet Time Series algorithm. It addresses the problem of reactive management in water production companies ; where decisions are made based on immediate need rather than data-driven projections. By forecasting future water demand, the system enables water production companies to plan production proactively.

## Tech Stack
- **Frontend:** React.js 19.3.0
- **Backend:** Node.js 22.16.0
- **Database:** PostgreSQL 17
- **ML Component:** Python 3.13.5 + Prophet 1.4.0
- **Version Control:** GitHub
- **Model Storage:** Google Drive
- **AI Tool:** Claude Code

## Dataset
Official İZSU (İzmir Water and Sewerage Administration) billed water consumption
data, sourced from the İzmir Metropolitan Municipality Open Data Portal:
https://acikveri.bizizmir.com/en/dataset/yillik-ilce-ve-mahalle-bazli-su-tuketim-miktarlari

1,143,347 individual billed water-consumption records (water rows only,
wastewater excluded) were aggregated into 128 monthly city-wide totals
spanning January 2014 to August 2024. Five outlier months were interpolated
using a centered 13-month rolling median (values beyond 1.4x / below 0.6x the
median were treated as outliers), with the rule fitted on the training
period only (Jan 2014 - Jun 2022) so no test-period months were used or
flagged: the September 2019 billing spike, the April-June 2020 COVID-19
meter-reading suspension and subsequent catch-up, and August 2020.

**Data provenance:**
- Raw consumption file: `izsu-yillik-ilce-mahalle-su-tuketimi.csv`, downloaded 18 October 2026, 1,143,347 rows, Jan 2014 - Sep 2024 (Sep 2024 incomplete, excluded). SHA-256: `c8199e62993d99cb811af24833864d06b7be83985b48285d558cd7b8db917b4d`
- Tariff file: `su-atiksu-tarifeleri.csv`, downloaded 25 October 2026. SHA-256: `a605ba7cc0b2315d70c1a8c201f05ab479ef13e68c6ee80e94c54cee11d80811`
- Water-loss report (2019, the only year published): `su-kayiplari-2019.csv`, downloaded 25 October 2026. SHA-256: `57f6b34bf9bdc5c3b91fce8cffb6211665fa2f5969c4374eaaf279467da1981d`

An earlier version of this project used a Kaggle dataset
("Izmir dataset.csv"). That dataset was replaced because its consumption
column turned out to be synthetic — every month was exactly 1.025x the same
month of the prior year — which produced unrealistically low error rates
that did not reflect real forecasting performance.

## How It Works
1. Official İZSU billed consumption data is loaded into the `izsu_consumption` table in PostgreSQL.
2. The data is split chronologically 80/20 — 102 months for training, 26 months held out for testing.
3. Prophet trains on the 102 training months (default hyperparameters) and is evaluated against the 26 held-out months using MAE, RMSE and MAPE.
4. A 24-combination hyperparameter grid search was run via cross-validation on the training data only; it found no configuration that reliably beat Prophet's defaults on the held-out test set, so defaults remain in production.
5. The final model retrains on all 128 months and saves to Google Drive.
6. A Node.js/Express API runs the forecasting script on request and serves the results to a React dashboard, where production managers can view forecasts, accuracy metrics, and historical consumption trends.

## Current Results
Evaluated on the 26-month held-out test set:

- **Prophet (default settings):** MAE 1,027,291 m3, RMSE 1,308,929 m3, MAPE 4.86%
- **Prophet (CV-tuned settings — 0.01 / 1 / multiplicative):** MAPE 5.71%
- **Seasonal-naive baseline** (repeat last 12 months): MAPE 5.47%
- **Last-year × growth baseline:** MAPE 6.23%
- **Prophet cross-validation** (12 folds, training data only): MAPE 6.76%

A 24-combination grid search over `changepoint_prior_scale`,
`seasonality_prior_scale` and `seasonality_mode` was run with 12-fold
cross-validation on the training data only. The best configuration by
cross-validation RMSE (0.01 / 1 / multiplicative) performed worse than
Prophet's defaults on the held-out test set (MAPE 5.71% vs 4.86%), so the
defaults were retained. Because this choice was made after seeing test-set
results, the 4.86% figure may be slightly optimistic; this is disclosed here
and in Chapter 5. For future models (e.g. SARIMA), the selection rule is fixed
using cross-validation before the test set is used, and the test set is used once.
As required when test results influence a choice, an independent re-evaluation
of the default vs CV-tuned settings (on newer İZSU months if available,
otherwise a pre-specified rolling-origin comparison with a Diebold-Mariano
test) is planned and will be reported in Chapter 5.

## Sprint II Task Status
Project objectives: (1) analyse current water management systems and
forecasting approaches, (2) evaluate existing systems, (3) identify gaps,
(4) design and develop the integrated forecasting system, (5) test and
validate it.

| Task | Linked Objective(s) | Status |
|---|---|---|
| Literature review, analysis of existing systems and gap identification (Chapters 1-2) | 1, 2, 3 | Done |
| Dataset validation and replacement with İZSU data | 4, 5 | Done |
| Database and data loading | 4 | Done |
| Prophet model and evaluation pipeline | 4, 5 | Done |
| Baselines and cross-validation | 5 | Done |
| Hyperparameter tuning | 5 | Done |
| API integration | 4 | Done |
| Dashboard forecast and history pages | 4 | Done |
| Authentication and roles | 4 | Done |
| Testing evidence | 5 | Done |
| Run records | 5 | Done |
| Save forecasts to forecasts/forecast_results tables | 4 | Done |
| Load saved model in the API instead of retraining | 4 | Done |
| Show confidence band on chart | 4 | Done |
| Forecast horizon selection (3/6/12 months) and baseline comparison on dashboard | 4, 5 | Done |
| Climate regressors from official sources (Open-Meteo, TÜİK) | 4, 5 | Next |
| Chapter 5 | 5 | Next |
| Hosting (Sprint III) | 4 | Next |

## Known Limitations
- Billed water consumption is used as a proxy for demand, not a direct physical measurement.
- The dataset is from İzmir, Turkey — not from a Kenyan utility.
- Only 128 monthly records are available, limiting how much pattern Prophet can learn.
- Monthly billing cycles don't align perfectly with calendar months, adding timing noise.
- 5 outlier months were interpolated rather than using the true billed values.
- A forecast request takes about 4 seconds (the saved model is loaded, not retrained).
- No external regressors (temperature, population, etc.) are used yet — only the consumption time series itself.
- The frontend's automated test suite (`App.test.js`) currently fails (Jest/react-router-dom module resolution error).
- The system runs locally only — no hosting/deployment has been set up.
- 5.34% of consumption is unpriced (no matching tariff).
- Tariff duplicates in 32 price dates make some historical months' revenue unavailable.
- Customer group inferred from type name for 6,186 rows (Aug 2023 onward).
- Two districts in the 2019 water balance don't balance in the source.

## Setup Instructions

### Prerequisites
- Node.js (tested with v22.16.0)
- Python (tested with 3.13.5)
- PostgreSQL 17

### 1. Install dependencies
```bash
cd backend && npm install
cd ../frontend && npm install
cd .. && pip install -r requirements.txt
```

### 2. Configure environment variables
Copy `.env.example` to `.env` in the project root, then fill in your own values:
```bash
cp .env.example .env
```

### 3. Set up the database and load the data
You'll need three source files from İZSU (the İzmir Metropolitan
Municipality Open Data Portal — the consumption file is at
https://acikveri.bizizmir.com/en/dataset/yillik-ilce-ve-mahalle-bazli-su-tuketim-miktarlari,
the tariff and water-loss files from the same portal): the raw billed
consumption records, the water/wastewater tariff list, and the 2019
water-loss (water balance) report. Point `.env` at wherever you put them —
`IZSU_RAW_PATH`, `IZSU_TARIFF_PATH`, `IZSU_LOSS_PATH` — plus
`IZSU_DETAIL_PATH` and `IZSU_MONTHLY_PATH` for the two files
`preprocess_izsu.py` generates from the raw one (step 3 below). All five
default to paths under `Documents` if left unset in `.env`.

Run these in order:

1. `psql`/pgAdmin: `database/schema/000_existing_schema.sql` — creates the baseline tables (`users`, `izsu_consumption`, `forecasts`, `forecast_results`) if they don't already exist.
2. `psql`/pgAdmin: `database/schema/001_foundation.sql` — adds RBAC, consumption detail, tariffs, water balance, settings, production planning and the audit log.
3. `python database/preprocess_izsu.py` — raw file -> monthly totals + district/customer detail.
4. `python database/load_izsu.py` — 128 monthly totals.
5. `python database/load_detail.py` — 86,749 detail rows.
6. `python database/load_tariffs.py` — 1,582 water tariff rows, 39 price dates.
7. `python database/load_water_balance.py` — 2019 water balance, 20 districts.
8. `python database/build_tariff_map.py` — builds `tariff_type_map.csv` from the proposal.
9. `python database/load_tariff_map.py` — 90 mappings; 94.66% of consumption priced.
10. `python database/seed_users.py` — creates the two test accounts (reads `SEED_MANAGER_PASSWORD`/`SEED_ADMIN_PASSWORD` from `.env`).

This creates two test accounts:
| Email | Role |
|---|---|
| manager@water.com | manager |
| admin@water.com | admin |

`database/propose_tariff_map.py` is not part of this sequence — it's only
needed if you want to regenerate `tariff_type_map_proposal.csv` (the input
to step 8) from scratch, e.g. after the detail data changes.

### 4. Train the forecasting model
`ml/forecast_api.py` loads a saved model rather than training one on each
request, so train and save it first:
```bash
python ml/train_model.py
```

### 5. Start the application
Start the backend (runs on http://localhost:5000):
```bash
cd backend
node index.js
```

In a separate terminal, start the frontend (runs on http://localhost:3000):
```bash
cd frontend
npm start
```

## Deployment Requirements (for Sprint III)
Checked against the current code:

- **Node runtime** to run `backend/index.js` (Express). Port is already configurable via `PORT` in `.env`.
- **Python with Prophet and cmdstan** to run `ml/forecast_api.py` on each forecast request. cmdstanpy's model fitting is memory-sensitive — an OpenBLAS memory allocation failure was observed even on this local machine during testing — so the host needs adequate RAM, not just disk/CPU.
- **A managed PostgreSQL instance** for `izsu_consumption` and `users` (the current `DB_HOST`/`DB_PORT` point at `localhost`).
- **All `.env` variables** set on the host (see `.env.example`): `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `JWT_SECRET`, `SEED_MANAGER_PASSWORD`, `SEED_ADMIN_PASSWORD`, `RUNS_DIR`, `MODEL_PATH`.
- **Model storage:** `MODEL_PATH` is now configurable via `.env` (read by `ml/train_model.py` and `ml/forecast_api.py`), so this is no longer a hardcoded blocker — but it still defaults to a Windows path, `G:\My Drive\water-demand-forecasting\models\prophet_model.pkl`, so a non-Windows host must set `MODEL_PATH` explicitly to somewhere it can actually write. `database/load_izsu.py` similarly reads its source CSV from a hardcoded local path.
- **Frontend build hosting** for the React app (e.g. a static host after `npm run build`), separate from the Node backend.
- **Hardcoded `http://localhost:5000` API URLs in the frontend** — present in `Login.js`, `Dashboard.js`, and `DataOverview.js` — must become a configurable value (e.g. a build-time environment variable) before the frontend can reach a backend that isn't running on the same machine.
