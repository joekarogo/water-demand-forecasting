-- Adds the columns needed to store manager-generated forecasts end-to-end.
--
-- Existing columns before this migration:
--   forecasts:        forecast_id, user_id, generated_at, forecast_period, mae, rmse
--   forecast_results: result_id, forecast_id, date, predicted_value
--
-- forecast_period, mae and rmse already existed and are reused as-is.
-- New columns added here: horizon, model_name, mape (forecasts) and
-- yhat_lower, yhat_upper (forecast_results, matching the API's existing
-- yhat_lower/yhat_upper field names for consistency).

ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS horizon INTEGER;
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS model_name VARCHAR(50);
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS mape DOUBLE PRECISION;

ALTER TABLE forecast_results ADD COLUMN IF NOT EXISTS yhat_lower DOUBLE PRECISION;
ALTER TABLE forecast_results ADD COLUMN IF NOT EXISTS yhat_upper DOUBLE PRECISION;
