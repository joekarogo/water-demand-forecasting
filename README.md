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
median were treated as outliers): the September 2019 billing spike, the
April-June 2020 COVID-19 meter-reading suspension and subsequent catch-up,
and August 2020.

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
- **Seasonal-naive baseline** (repeat last 12 months): MAPE 5.47%
- **Last-year × growth baseline:** MAPE 6.23%
- **Prophet cross-validation** (12 folds, training data only): MAPE 6.76%

A 24-combination grid search over `changepoint_prior_scale`,
`seasonality_prior_scale`, and `seasonality_mode` found no configuration that
reliably improved on Prophet's defaults when checked against the held-out
test set, so the defaults remain in production.

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
| Save forecasts to forecasts/forecast_results tables | 4 | Next |
| Load saved model in the API instead of retraining | 4 | Next |
| Show confidence band on chart | 4 | Next |
| Climate regressors from official sources (Open-Meteo, TÜİK) | 4, 5 | Next |
| Chapter 5 | 5 | Next |
| Hosting (Sprint III) | 4 | Next |

## Known Limitations
- Billed water consumption is used as a proxy for demand, not a direct physical measurement.
- The dataset is from İzmir, Turkey — not from a Kenyan utility.
- Only 128 monthly records are available, limiting how much pattern Prophet can learn.
- Monthly billing cycles don't align perfectly with calendar months, adding timing noise.
- 5 outlier months were interpolated rather than using the true billed values.
- `ml/forecast_api.py` retrains both Prophet models (test-set and final) from scratch on every `/api/forecast` request — it does not load a saved model. One request takes roughly 15-20 seconds.
- Forecasts are not yet stored in the database; the API always serves a freshly computed result.
- No external regressors (temperature, population, etc.) are used yet — only the consumption time series itself.
- The frontend's automated test suite (`App.test.js`) currently fails (Jest/react-router-dom module resolution error).
- The system runs locally only — no hosting/deployment has been set up.
- The original `consumption_data` table (from the deprecated Kaggle file) still exists in the database but is unused by the model.

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

### 3. Set up the database
Create the `izsu_consumption` table and load the İZSU consumption data into it:
```bash
psql -U <your_db_user> -d <your_db_name> -f database/create_izsu_consumption.sql
python database/load_izsu.py
```

The `users` table (used for login) is not created by a script in this repo —
create it manually, e.g. via `psql`:
```sql
CREATE TABLE users (
    user_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Then seed the test accounts (reads `SEED_MANAGER_PASSWORD` and
`SEED_ADMIN_PASSWORD` from your `.env`, hashes them, and inserts/updates the
users):
```bash
python database/seed_users.py
```

This creates two test accounts:
| Email | Role |
|---|---|
| manager@water.com | manager |
| admin@water.com | admin |

### 4. Start the application
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
- **All `.env` variables** set on the host (see `.env.example`): `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_PORT`, `JWT_SECRET`, `SEED_MANAGER_PASSWORD`, `SEED_ADMIN_PASSWORD`, `RUNS_DIR`.
- **Model storage:** `ml/forecast.py` and `ml/forecast_api.py` both save the trained model to a hardcoded Windows path, `G:\My Drive\water-demand-forecasting\models\prophet_model.pkl` — this must become a configurable path (or be dropped, since the API doesn't actually load this saved model — see Known Limitations) before hosting on a non-Windows server. `database/load_izsu.py` similarly reads its source CSV from a hardcoded local path.
- **Frontend build hosting** for the React app (e.g. a static host after `npm run build`), separate from the Node backend.
- **Hardcoded `http://localhost:5000` API URLs in the frontend** — present in `Login.js`, `Dashboard.js`, and `DataOverview.js` — must become a configurable value (e.g. a build-time environment variable) before the frontend can reach a backend that isn't running on the same machine.
