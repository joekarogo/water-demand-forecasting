-- Reproduces the schema as of 25 Oct 2026.
--
-- These are the tables already live in the database before the foundation
-- migration (001_foundation.sql) runs, captured here so the schema is
-- reproducible on a fresh database rather than assumed to already exist.
--
-- production_records and analytics_reports are deliberately NOT included —
-- they are unused (0 rows each) and are dropped by 001_foundation.sql.

CREATE TABLE IF NOT EXISTS users (
    user_id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS izsu_consumption (
    date DATE PRIMARY KEY,
    consumption_m3 BIGINT,
    consumption_cleaned_m3 BIGINT,
    is_outlier VARCHAR(3),
    subscribers INTEGER
);

CREATE TABLE IF NOT EXISTS forecasts (
    forecast_id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(user_id),
    generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    forecast_period VARCHAR(50),
    mae DOUBLE PRECISION,
    rmse DOUBLE PRECISION,
    horizon INTEGER,
    model_name VARCHAR(50),
    mape DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS forecast_results (
    result_id SERIAL PRIMARY KEY,
    forecast_id INTEGER REFERENCES forecasts(forecast_id),
    date DATE NOT NULL,
    predicted_value DOUBLE PRECISION NOT NULL,
    yhat_lower DOUBLE PRECISION,
    yhat_upper DOUBLE PRECISION
);
