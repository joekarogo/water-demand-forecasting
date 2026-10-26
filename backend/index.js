const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const planning = require('./planning');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = process.env.PORT || 5000;

// JWT auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      // 401, not 403: an invalid/expired token means "you aren't signed
      // in", not "you don't have permission" — 403 is reserved for
      // requireAdmin/requirePermission denying an authenticated user.
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    req.user = decoded;
    next();
  });
}

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Water Demand Forecasting API is running' });
});

// Short reference for an error response, e.g. "ERR-4F7K2A" — logged
// server-side next to the full error, shown to the client instead of raw
// error details.
function generateErrorReference() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `ERR-${code}`;
}

app.get('/api/forecast/published', authenticateToken, async (req, res) => {
  try {
    const forecastResult = await pool.query(
      `SELECT forecast_id, generated_at, model_name, mae, rmse, mape,
              TO_CHAR(data_up_to, 'YYYY-MM-DD') AS data_up_to,
              TO_CHAR(train_start, 'YYYY-MM-DD') AS train_start,
              TO_CHAR(train_end, 'YYYY-MM-DD') AS train_end,
              interval_width::double precision AS interval_width
       FROM forecasts
       WHERE kind = 'published'
       ORDER BY generated_at DESC
       LIMIT 1`
    );

    if (forecastResult.rows.length === 0) {
      return res.status(404).json({ error: 'No forecast has been published yet.' });
    }

    const publishedForecast = forecastResult.rows[0];

    const resultsResult = await pool.query(
      `SELECT TO_CHAR(date, 'YYYY-MM-DD') AS date, predicted_value, yhat_lower, yhat_upper
       FROM forecast_results
       WHERE forecast_id = $1
       ORDER BY date`,
      [publishedForecast.forecast_id]
    );

    const historyResult = await pool.query(
      `SELECT TO_CHAR(date, 'YYYY-MM-DD') AS date, consumption_cleaned_m3::double precision AS actual
       FROM izsu_consumption
       ORDER BY date`
    );

    const lossRateResult = await pool.query(
      `SELECT value, source FROM settings WHERE key = 'loss_rate'`
    );
    const lossRateRow = lossRateResult.rows[0];

    res.json({
      published_at: publishedForecast.generated_at,
      model_name: publishedForecast.model_name,
      train_start: publishedForecast.train_start,
      train_end: publishedForecast.train_end,
      data_up_to: publishedForecast.data_up_to,
      interval_width: publishedForecast.interval_width,
      metrics: {
        mae: publishedForecast.mae,
        rmse: publishedForecast.rmse,
        mape: publishedForecast.mape,
      },
      loss_rate: lossRateRow ? Number(lossRateRow.value) : null,
      loss_rate_source: lossRateRow ? lossRateRow.source : null,
      forecast: resultsResult.rows.map((row) => ({
        date: row.date,
        yhat: row.predicted_value,
        yhat_lower: row.yhat_lower,
        yhat_upper: row.yhat_upper,
      })),
      history: historyResult.rows.map((row) => ({
        date: row.date,
        actual: row.actual,
      })),
    });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] /api/forecast/published failed:`, err);
    res.status(500).json({
      error: 'Unable to load the published forecast right now.',
      reference,
    });
  }
});

// Admin-only role check — used after authenticateToken, which populates req.user
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Permission check — used after authenticateToken. Looks up the caller's
// role and that role's permissions fresh from the database on every
// request (users -> roles -> role_permissions -> permissions), rather
// than trusting the role baked into the JWT, so a deactivated account or
// a permission removed after the token was issued takes effect
// immediately. Deny by default: no role, an unknown permission code, or a
// database error all mean no access — a database error is the one case
// that isn't a plain 403, since it's not actually known whether the user
// has the permission or not; it's reported as a 500 with an ERR reference
// instead of ever allowing the request through.
function requirePermission(code) {
  return async (req, res, next) => {
    if (!req.user || !req.user.user_id) {
      return res.status(403).json({ error: "You don't have permission to do this." });
    }

    try {
      const result = await pool.query(
        `SELECT 1
         FROM users u
         JOIN roles r ON r.role_id = u.role_id
         JOIN role_permissions rp ON rp.role_id = r.role_id
         JOIN permissions p ON p.permission_id = rp.permission_id
         WHERE u.user_id = $1 AND u.status = 'active' AND p.code = $2
         LIMIT 1`,
        [req.user.user_id, code]
      );

      if (result.rows.length === 0) {
        return res.status(403).json({ error: "You don't have permission to do this." });
      }

      next();
    } catch (err) {
      const reference = generateErrorReference();
      console.error(`[${reference}] requirePermission(${code}) failed:`, err);
      res.status(500).json({ error: 'Unable to verify permissions right now.', reference });
    }
  };
}

app.get('/api/consumption-history', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      // consumption_cleaned_m3 is BIGINT, which node-postgres returns as a
      // string by default (to avoid precision loss past Number.MAX_SAFE_INTEGER).
      // Our values are well within safe integer range, so cast to double
      // precision to get back a real JS number.
      "SELECT TO_CHAR(date, 'YYYY-MM-DD') AS date, consumption_cleaned_m3::double precision AS consumption_m3 FROM izsu_consumption ORDER BY date"
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('Consumption history error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Production Planning (Module 3)
// ---------------------------------------------------------------------------

async function getLatestPublishedForecast(queryable) {
  const result = await queryable.query(
    `SELECT forecast_id, generated_at,
            TO_CHAR(data_up_to, 'YYYY-MM-DD') AS data_up_to
     FROM forecasts
     WHERE kind = 'published'
     ORDER BY generated_at DESC
     LIMIT 1`
  );
  return result.rows[0] || null;
}

async function getLossRate(queryable) {
  const result = await queryable.query(`SELECT value, source FROM settings WHERE key = 'loss_rate'`);
  const row = result.rows[0];
  return row ? { value: Number(row.value), source: row.source } : null;
}

async function getForecastMonths(queryable, forecastId) {
  const result = await queryable.query(
    `SELECT TO_CHAR(date, 'YYYY-MM-DD') AS date, predicted_value, yhat_lower, yhat_upper
     FROM forecast_results
     WHERE forecast_id = $1
     ORDER BY date`,
    [forecastId]
  );
  return result.rows;
}

async function getActivePlansByMonth(queryable, forecastId) {
  const result = await queryable.query(
    `SELECT TO_CHAR(pp.plan_month, 'YYYY-MM-DD') AS plan_month, pp.plan_type,
            pp.chosen_m3::double precision AS chosen_m3, pp.reason, pp.notes,
            pp.version, pp.created_at, u.name AS created_by_name
     FROM production_plans pp
     JOIN users u ON u.user_id = pp.created_by
     WHERE pp.forecast_id = $1 AND pp.is_active = true`,
    [forecastId]
  );
  const byMonth = new Map();
  result.rows.forEach((row) => byMonth.set(row.plan_month, row));
  return byMonth;
}

// Date-only "YYYY-MM-DD" string, and an actual calendar date (rejects
// e.g. "2024-02-30").
function isValidDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

app.get('/api/production/plan', authenticateToken, requirePermission('plan:view'), async (req, res) => {
  try {
    const forecast = await getLatestPublishedForecast(pool);
    if (!forecast) {
      return res.status(404).json({ error: 'No forecast has been published yet.' });
    }

    const lossRate = await getLossRate(pool);
    const forecastMonths = await getForecastMonths(pool, forecast.forecast_id);
    const activePlansByMonth = await getActivePlansByMonth(pool, forecast.forecast_id);

    const months = forecastMonths.map((row) => {
      const normal_m3 = lossRate ? planning.calculateNormalM3(row.predicted_value, lossRate.value) : null;
      const safe_m3 = lossRate ? planning.calculateSafeM3(row.yhat_upper, lossRate.value) : null;
      const activePlan = activePlansByMonth.get(row.date);

      return {
        month: row.date,
        forecast_m3: row.predicted_value,
        lower_m3: row.yhat_lower,
        upper_m3: row.yhat_upper,
        normal_m3,
        safe_m3,
        plan: activePlan
          ? {
              plan_type: activePlan.plan_type,
              chosen_m3: activePlan.chosen_m3,
              reason: activePlan.reason,
              note: activePlan.notes,
              version: activePlan.version,
              created_by: activePlan.created_by_name,
              created_at: activePlan.created_at,
              below_expected:
                activePlan.plan_type === 'custom' && normal_m3 != null && activePlan.chosen_m3 < normal_m3,
            }
          : null,
      };
    });

    const stockResult = await pool.query(
      `SELECT TO_CHAR(recorded_on, 'YYYY-MM-DD') AS recorded_on,
              stock_m3::double precision AS stock_m3, note
       FROM stock_entries
       ORDER BY recorded_on DESC, entry_id DESC
       LIMIT 1`
    );
    const latestStock = stockResult.rows[0] || null;

    let days_of_cover = null;
    if (latestStock && months.length > 0 && months[0].plan) {
      const [year, month] = months[0].month.split('-').map(Number);
      const daysInFirstMonth = planning.daysInMonth(year, month);
      days_of_cover = planning.calculateDaysOfCover(
        latestStock.stock_m3,
        months[0].plan.chosen_m3,
        daysInFirstMonth
      );
    }

    res.json({
      forecast_id: forecast.forecast_id,
      published_at: forecast.generated_at,
      data_up_to: forecast.data_up_to,
      loss_rate: lossRate ? lossRate.value : null,
      loss_rate_source: lossRate ? lossRate.source : null,
      months,
      latest_stock: latestStock,
      days_of_cover,
    });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] /api/production/plan failed:`, err);
    res.status(500).json({ error: 'Unable to load the production plan right now.', reference });
  }
});

app.get(
  '/api/production/plan/:month/history',
  authenticateToken,
  requirePermission('plan:view'),
  async (req, res) => {
    try {
      const forecast = await getLatestPublishedForecast(pool);
      if (!forecast) {
        return res.status(404).json({ error: 'No forecast has been published yet.' });
      }

      const forecastMonths = await getForecastMonths(pool, forecast.forecast_id);
      const isValidMonth = forecastMonths.some((m) => m.date === req.params.month);
      if (!isValidMonth) {
        return res.status(400).json({ error: `${req.params.month} is not one of this forecast's months.` });
      }

      const result = await pool.query(
        `SELECT pp.plan_id, pp.plan_type, pp.chosen_m3::double precision AS chosen_m3,
                pp.reason, pp.notes, pp.version, pp.is_active, pp.created_at,
                u.name AS created_by_name
         FROM production_plans pp
         JOIN users u ON u.user_id = pp.created_by
         WHERE pp.forecast_id = $1 AND pp.plan_month = $2
         ORDER BY pp.version DESC`,
        [forecast.forecast_id, req.params.month]
      );

      res.json({
        month: req.params.month,
        history: result.rows.map((row) => ({
          plan_id: row.plan_id,
          plan_type: row.plan_type,
          chosen_m3: row.chosen_m3,
          reason: row.reason,
          note: row.notes,
          version: row.version,
          is_active: row.is_active,
          created_by: row.created_by_name,
          created_at: row.created_at,
        })),
      });
    } catch (err) {
      const reference = generateErrorReference();
      console.error(`[${reference}] /api/production/plan/:month/history failed:`, err);
      res.status(500).json({ error: 'Unable to load plan history right now.', reference });
    }
  }
);

app.post('/api/production/plan', authenticateToken, requirePermission('plan:create'), async (req, res) => {
  const { forecast_id, month, plan_type, expected_version, custom_m3, reason, note } = req.body;

  if (
    !Number.isInteger(forecast_id) ||
    typeof month !== 'string' ||
    !Number.isInteger(expected_version) ||
    expected_version < 0
  ) {
    return res.status(400).json({
      error: 'Validation failed.',
      fields: {
        ...(Number.isInteger(forecast_id) ? {} : { forecast_id: 'forecast_id is required.' }),
        ...(typeof month === 'string' ? {} : { month: 'month is required.' }),
        ...(Number.isInteger(expected_version) && expected_version >= 0
          ? {}
          : { expected_version: 'expected_version is required (0 if there is no plan yet).' }),
      },
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const latestForecast = await getLatestPublishedForecast(client);
    if (!latestForecast) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No forecast has been published yet.' });
    }

    if (forecast_id !== latestForecast.forecast_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A newer forecast has been published. Reload the page.' });
    }

    const forecastMonths = await getForecastMonths(client, latestForecast.forecast_id);
    const monthRow = forecastMonths.find((m) => m.date === month);
    if (!monthRow) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `${month} is not one of this forecast's months.` });
    }

    const lossRate = await getLossRate(client);
    if (!lossRate) {
      await client.query('ROLLBACK');
      const reference = generateErrorReference();
      console.error(`[${reference}] POST /api/production/plan: loss_rate is not configured`);
      return res.status(500).json({ error: 'Unable to save the production plan right now.', reference });
    }

    const normal_m3 = planning.calculateNormalM3(monthRow.predicted_value, lossRate.value);
    const safe_m3 = planning.calculateSafeM3(monthRow.yhat_upper, lossRate.value);

    const { valid, errors } = planning.validatePlanRequest({ plan_type, custom_m3, reason, note, safe_m3 });
    if (!valid) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Validation failed.', fields: errors });
    }

    const currentResult = await client.query(
      `SELECT version FROM production_plans WHERE forecast_id = $1 AND plan_month = $2 AND is_active = true`,
      [latestForecast.forecast_id, month]
    );
    const currentVersion = currentResult.rows[0] ? currentResult.rows[0].version : 0;

    if (currentVersion !== expected_version) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'This plan was changed by someone else. Reload to see the latest version.' });
    }

    const chosen_m3 = plan_type === 'custom' ? custom_m3 : plan_type === 'safe' ? safe_m3 : normal_m3;
    const planReason = plan_type === 'custom' ? reason : null;
    const trimmedNote = typeof note === 'string' && note.trim().length > 0 ? note.trim() : null;
    const newVersion = currentVersion + 1;

    if (currentVersion > 0) {
      await client.query(
        `UPDATE production_plans SET is_active = false
         WHERE forecast_id = $1 AND plan_month = $2 AND is_active = true`,
        [latestForecast.forecast_id, month]
      );
    }

    const insertResult = await client.query(
      `INSERT INTO production_plans
         (plan_month, forecast_id, forecast_m3, forecast_upper_m3, loss_rate, planned_m3, safe_plan_m3,
          chosen_m3, plan_type, reason, notes, version, is_active, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13)
       RETURNING plan_id, created_at`,
      [
        month,
        latestForecast.forecast_id,
        Math.round(monthRow.predicted_value),
        Math.round(monthRow.yhat_upper),
        lossRate.value,
        normal_m3,
        safe_m3,
        chosen_m3,
        plan_type,
        planReason,
        trimmedNote,
        newVersion,
        req.user.user_id,
      ]
    );
    const savedPlan = insertResult.rows[0];

    await client.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip_address)
       VALUES ($1, 'plan.save', 'production_plan', $2, $3, $4)`,
      [
        req.user.user_id,
        String(savedPlan.plan_id),
        { month, plan_type, chosen_m3, version: newVersion, forecast_id: latestForecast.forecast_id },
        req.ip,
      ]
    );

    await client.query('COMMIT');

    res.json({
      plan_id: savedPlan.plan_id,
      month,
      forecast_id: latestForecast.forecast_id,
      plan_type,
      chosen_m3,
      reason: planReason,
      note: trimmedNote,
      version: newVersion,
      created_by: req.user.name,
      created_at: savedPlan.created_at,
      forecast_m3: monthRow.predicted_value,
      upper_m3: monthRow.yhat_upper,
      normal_m3,
      safe_m3,
      below_expected: plan_type === 'custom' && chosen_m3 < normal_m3,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }

    if (err.code === '23505') {
      // Two simultaneous saves both passed the expected_version check,
      // then raced on the unique (forecast_id, plan_month[, version])
      // index — same outcome as a stale expected_version, so report it
      // the same way instead of a raw 500.
      return res
        .status(409)
        .json({ error: 'This plan was changed by someone else. Reload to see the latest version.' });
    }

    const reference = generateErrorReference();
    console.error(`[${reference}] POST /api/production/plan failed:`, err);
    res.status(500).json({ error: 'Unable to save the production plan right now.', reference });
  } finally {
    client.release();
  }
});

const STOCK_TREND_WINDOW_DAYS = 90;
const STOCK_TREND_MAX_ROWS = 200;

app.get('/api/production/stock', authenticateToken, requirePermission('plan:view'), async (req, res) => {
  try {
    // change_m3 (LAG) is computed over EVERY entry, ordered chronologically
    // (same-date ties broken by entry_id) — only AFTER that is the result
    // narrowed to the trailing window, so the oldest entry kept still
    // compares against the real reading before it, not against nothing.
    const result = await pool.query(
      `WITH all_entries AS (
         SELECT se.entry_id, se.recorded_on, se.stock_m3, se.note, se.created_by,
                se.stock_m3 - LAG(se.stock_m3) OVER (ORDER BY se.recorded_on, se.entry_id) AS change_m3
         FROM stock_entries se
       ),
       latest AS (
         SELECT MAX(recorded_on) AS max_date FROM stock_entries
       )
       SELECT TO_CHAR(ae.recorded_on, 'YYYY-MM-DD') AS recorded_on,
              ae.stock_m3::double precision AS stock_m3,
              ae.note,
              u.name AS recorded_by,
              ae.change_m3::double precision AS change_m3
       FROM all_entries ae
       JOIN users u ON u.user_id = ae.created_by
       CROSS JOIN latest
       WHERE ae.recorded_on >= latest.max_date - $1::integer
       ORDER BY ae.recorded_on DESC, ae.entry_id DESC
       LIMIT $2`,
      [STOCK_TREND_WINDOW_DAYS, STOCK_TREND_MAX_ROWS]
    );
    res.json({ data: result.rows, window_days: STOCK_TREND_WINDOW_DAYS });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] /api/production/stock failed:`, err);
    res.status(500).json({ error: 'Unable to load stock entries right now.', reference });
  }
});

app.post('/api/production/stock', authenticateToken, requirePermission('stock:create'), async (req, res) => {
  const { recorded_on, stock_m3, note } = req.body;
  const errors = {};

  if (!isValidDateString(recorded_on)) {
    errors.recorded_on = 'Choose a valid date';
  }
  const stockAmountError = planning.validateStockAmount(stock_m3);
  if (stockAmountError) {
    errors.stock_m3 = stockAmountError;
  }

  let trimmedNote = null;
  if (note !== undefined && note !== null) {
    const trimmed = typeof note === 'string' ? note.trim() : '';
    if (trimmed.length > 500) {
      errors.note = 'The note can be at most 500 characters';
    } else if (trimmed.length > 0) {
      trimmedNote = trimmed;
    }
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ error: 'Validation failed.', fields: errors });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // "Not after today" per the DATABASE's clock, not the Node server's.
    const todayResult = await client.query(`SELECT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD') AS today`);
    const today = todayResult.rows[0].today;
    if (recorded_on > today) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Validation failed.',
        fields: { recorded_on: "The date can't be in the future" },
      });
    }

    const insertResult = await client.query(
      `INSERT INTO stock_entries (recorded_on, stock_m3, note, created_by)
       VALUES ($1, $2, $3, $4)
       RETURNING entry_id, created_at`,
      [recorded_on, stock_m3, trimmedNote, req.user.user_id]
    );
    const savedEntry = insertResult.rows[0];

    await client.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip_address)
       VALUES ($1, 'stock.record', 'stock_entry', $2, $3, $4)`,
      [req.user.user_id, String(savedEntry.entry_id), { recorded_on, stock_m3 }, req.ip]
    );

    await client.query('COMMIT');

    res.json({
      entry_id: savedEntry.entry_id,
      recorded_on,
      stock_m3,
      note: trimmedNote,
      recorded_by: req.user.name,
      created_at: savedEntry.created_at,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    const reference = generateErrorReference();
    console.error(`[${reference}] POST /api/production/stock failed:`, err);
    res.status(500).json({ error: 'Unable to save the stock entry right now.', reference });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query(
      'SELECT user_id, name, email, password, role FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const isMatch = bcrypt.compareSync(password, user.password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { user_id: user.user_id, name: user.name, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({
      token,
      user: {
        user_id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
