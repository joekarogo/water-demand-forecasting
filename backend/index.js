const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawnSync } = require('child_process');
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

const VALID_HORIZONS = [3, 6, 12];

app.get('/api/forecast', authenticateToken, async (req, res) => {
  const horizonParam = req.query.horizon;
  const horizon = horizonParam === undefined ? 6 : parseInt(horizonParam, 10);

  if (!VALID_HORIZONS.includes(horizon)) {
    return res.status(400).json({
      error: `Invalid horizon "${horizonParam}". Must be 3, 6, or 12.`,
    });
  }

  const projectRoot = path.join(__dirname, '..');

  // forecast_api.py now loads the model trained by ml/train_model.py
  // instead of retraining on every request, and prints a single JSON
  // object to stdout (not text for regex parsing).
  const result = spawnSync('python', ['ml/forecast_api.py', String(horizon)], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });

  if (result.error) {
    return res.status(500).json({
      error: 'Failed to run forecast script',
      details: result.error.message,
    });
  }

  if (result.status !== 0) {
    return res.status(500).json({
      error: 'Forecast script exited with an error',
      details: result.stderr,
    });
  }

  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch (err) {
    return res.status(500).json({
      error: 'Could not parse forecast output',
      raw_output: result.stdout,
    });
  }

  // Save this forecast: one row in `forecasts`, one row per predicted
  // month in `forecast_results`. A failure to save never fails the
  // request — the manager still gets their forecast either way.
  try {
    const insertForecast = await pool.query(
      `INSERT INTO forecasts (user_id, generated_at, horizon, model_name, mae, rmse, mape)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6)
       RETURNING forecast_id`,
      [req.user.user_id, horizon, data.model_name, data.metrics.mae, data.metrics.rmse, data.metrics.mape]
    );
    const forecastId = insertForecast.rows[0].forecast_id;

    for (const row of data.forecast) {
      await pool.query(
        `INSERT INTO forecast_results (forecast_id, date, predicted_value, yhat_lower, yhat_upper)
         VALUES ($1, $2, $3, $4, $5)`,
        [forecastId, row.date, row.yhat, row.yhat_lower, row.yhat_upper]
      );
    }
  } catch (err) {
    console.error('Failed to save forecast:', err);
  }

  res.json(data);
});

app.get('/api/forecasts/recent', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT forecast_id, generated_at, horizon, model_name, mae, rmse, mape
       FROM forecasts
       ORDER BY generated_at DESC
       LIMIT 5`
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('Recent forecasts error:', err);
    res.status(500).json({ error: 'Internal server error' });
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
      { user_id: user.user_id, email: user.email, role: user.role },
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
