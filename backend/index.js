const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
      return res.status(403).json({ error: 'Invalid or expired token' });
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
