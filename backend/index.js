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

app.get('/api/forecast', authenticateToken, (req, res) => {
  const projectRoot = path.join(__dirname, '..');

  // forecast_api.py mirrors forecast.py's 80/20 evaluation and 6 month
  // forecast but skips cross validation, so this route responds quickly.
  // Cross validation results are shown separately from pre-stored values.
  const result = spawnSync('python', ['ml/forecast_api.py'], {
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

  const output = result.stdout;

  // Parse MAE, RMSE, MAPE from the Model Evaluation section
  // (negative lookbehind excludes the cross-validation "Mean MAE"/"Mean RMSE" lines)
  const maeMatch = output.match(/(?<!Mean )MAE:\s*([\d,.-]+)\s*m3/);
  const rmseMatch = output.match(/(?<!Mean )RMSE:\s*([\d,.-]+)\s*m3/);
  const mapeMatch = output.match(/MAPE:\s*([\d,.-]+)%/);

  if (!maeMatch || !rmseMatch || !mapeMatch) {
    return res.status(500).json({
      error: 'Could not parse evaluation metrics from forecast output',
      raw_output: output,
    });
  }

  const mae = parseFloat(maeMatch[1].replace(/,/g, ''));
  const rmse = parseFloat(rmseMatch[1].replace(/,/g, ''));
  const mape = parseFloat(mapeMatch[1].replace(/,/g, ''));

  // Parse the 6 month forecast table
  const forecastSectionMatch = output.match(/Forecast for next 6 months:\s*([\s\S]*)$/);
  const forecast = [];

  if (forecastSectionMatch) {
    const rowRegex = /(\d{4}-\d{2}-\d{2})\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(forecastSectionMatch[1])) !== null) {
      forecast.push({
        date: rowMatch[1],
        yhat: parseFloat(rowMatch[2]),
        yhat_lower: parseFloat(rowMatch[3]),
        yhat_upper: parseFloat(rowMatch[4]),
      });
    }
  }

  if (forecast.length === 0) {
    return res.status(500).json({
      error: 'Could not parse forecast table from forecast output',
      raw_output: output,
    });
  }

  res.json({
    mae,
    rmse,
    mape,
    forecast,
  });
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
