const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const planning = require('./planning');
const distribution = require('./distribution');
const revenue = require('./revenue');
const revenueScenarios = require('./revenueScenarios');
const overview = require('./overview');
const users = require('./users');
const auth = require('./auth');
const packageJson = require('./package.json');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Heroku's router sits in front of every request, so without this,
// req.ip would be the router's address for every request alike — which
// would break the emergency-login IP lockout and make every audit-log IP
// identical. `1` trusts exactly one hop (Heroku's own router).
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

// PostgreSQL connection pool. DATABASE_URL (a single connection string)
// takes priority over the discrete DB_* vars when set — this is how
// backend/test/permissions.matrix.test.js points this exact app at a
// throwaway test database instead of the real one, without touching any
// of the query logic below. In production, DATABASE_URL is Heroku
// Postgres, which requires SSL but whose managed cert isn't in Node's
// default trust store — rejectUnauthorized: false is Heroku's own
// documented way to connect to it. The disposable local test database
// (also reached via DATABASE_URL, from the test file) never runs with
// NODE_ENV=production, so this never applies to it.
const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ...(IS_PRODUCTION ? { ssl: { rejectUnauthorized: false } } : {}),
      }
    : {
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
      }
);

app.use(
  cors({
    exposedHeaders: ['X-Session-Expires-In', 'X-Session-Max-Reached'],
    // In production this app serves the frontend itself (one origin), so
    // cross-origin requests have no legitimate use and are refused
    // outright; dev keeps the existing permissive default (reflects the
    // request's own Origin, same as passing no `origin` option at all).
    origin: IS_PRODUCTION ? false : true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Authentication middleware: cookie sessions only (Part 3A removed the
// password login and, with it, the Bearer/JWT fallback this used to have).
// The function name and req.user shape ({ user_id, name, email, role })
// are kept the same as before for every other route's sake. role is
// roles.name via users.role_id — users.role itself was dropped in
// 006_remove_password_login.sql.
async function authenticateToken(req, res, next) {
  const sid = req.cookies && req.cookies.sid;

  if (!sid) {
    return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
  }

  try {
    const sessionIdHash = auth.hashSessionId(sid);
    const sessionResult = await pool.query(
      `SELECT session_id_hash, user_id, csrf_token, created_at, expires_at
       FROM sessions WHERE session_id_hash = $1`,
      [sessionIdHash]
    );
    const session = sessionResult.rows[0];

    if (!session || new Date(session.expires_at) <= new Date()) {
      if (session) {
        // Expired sessions are deleted when found.
        await pool.query('DELETE FROM sessions WHERE session_id_hash = $1', [sessionIdHash]);
      }
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }

    const userResult = await pool.query(
      `SELECT u.user_id, u.name, u.email, r.name AS role
       FROM users u
       LEFT JOIN roles r ON r.role_id = u.role_id
       WHERE u.user_id = $1 AND u.status = 'active'`,
      [session.user_id]
    );
    const userRow = userResult.rows[0];

    if (!userRow) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }

    req.user = { user_id: userRow.user_id, name: userRow.name, email: userRow.email, role: userRow.role };

    // Sliding expiry: every valid request pushes expires_at forward,
    // capped at the 8-hour absolute limit from created_at.
    const sessionCreatedAt = new Date(session.created_at);
    const newExpiresAt = auth.computeSessionExpiry({
      now: new Date(),
      createdAt: sessionCreatedAt,
      roleName: userRow.role,
    });
    await pool.query('UPDATE sessions SET last_seen_at = now(), expires_at = $1 WHERE session_id_hash = $2', [
      newExpiresAt,
      sessionIdHash,
    ]);

    req.session = {
      id_hash: sessionIdHash,
      csrf_token: session.csrf_token,
      created_at: sessionCreatedAt,
      expires_at: newExpiresAt,
    };

    // Lets the frontend warn before the session ends without trusting the
    // browser's own clock — seconds remaining, not a timestamp. maxReached
    // flags the case where the 8-hour absolute cap (not the idle timeout)
    // is what's about to end the session, so the warning can say so.
    const secondsRemaining = Math.max(0, Math.round((newExpiresAt.getTime() - Date.now()) / 1000));
    const absoluteExpiryMs = sessionCreatedAt.getTime() + auth.ABSOLUTE_SESSION_LIMIT_MS;
    const maxReached = Math.abs(newExpiresAt.getTime() - absoluteExpiryMs) <= 1000;
    res.set('X-Session-Expires-In', String(secondsRemaining));
    res.set('X-Session-Max-Reached', maxReached ? 'true' : 'false');

    return next();
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] authenticateToken (session) failed:`, err);
    return res.status(500).json({ error: 'Unable to verify your session right now.', reference });
  }
}

// CSRF check for state-changing requests. req.session is always set by
// authenticateToken by the time this runs (cookie sessions are now the
// only way through it), but the guard is kept defensively.
function csrfProtection(req, res, next) {
  if (!req.session) {
    return next();
  }
  const provided = req.headers['x-csrf-token'];
  if (!auth.csrfTokensMatch(req.session.csrf_token, provided)) {
    return res.status(403).json({ error: 'Security check failed. Reload the page and try again.' });
  }
  next();
}

// 403 for a risky account-admin action (role change, deactivate,
// reactivate) whose session isn't fresh enough. req.session.created_at
// comes from the same sessions row every other check here already
// trusts — see auth.isWithinStepUpWindow for the pure rule itself.
function requireRecentAuth(req, res, next) {
  if (!req.session || !auth.isWithinStepUpWindow({ now: new Date(), sessionCreatedAt: req.session.created_at })) {
    return res.status(403).json({ error: 'For security, sign in again to make this change.', code: 'reauth_required' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes and their protection:
//
//   GET  /api/health                     public (health check)
//   GET  /api/forecast/published         authenticateToken, requirePermission('forecast:view')
//   GET  /api/me                         authenticateToken
//   GET  /api/me/sign-ins                authenticateToken
//   GET  /api/about                      authenticateToken
//   GET  /api/overview                   authenticateToken (sections shown vary by permission)
//   POST /api/auth/google                public
//   POST /api/auth/emergency-login       public (rate-limited by IP)
//   POST /api/auth/logout                authenticateToken, csrfProtection
//   GET  /api/consumption-history        authenticateToken, requirePermission('data:view')
//   GET  /api/production/plan            authenticateToken, requirePermission('plan:view')
//   GET  /api/production/plan/:month/history
//                                         authenticateToken, requirePermission('plan:view')
//   POST /api/production/plan            authenticateToken, csrfProtection, requirePermission('plan:create')
//   GET  /api/production/stock           authenticateToken, requirePermission('plan:view')
//   POST /api/production/stock           authenticateToken, csrfProtection, requirePermission('stock:create')
//   GET  /api/distribution               authenticateToken, requirePermission('distribution:view')
//   GET  /api/revenue                    authenticateToken, requirePermission('revenue:view')
//   POST /api/revenue/scenario           authenticateToken, csrfProtection, requirePermission('revenue:view')
//   GET  /api/roles                      authenticateToken, requirePermission('user:manage')
//   GET  /api/users                      authenticateToken, requirePermission('user:manage')
//   POST /api/users                      authenticateToken, csrfProtection, requirePermission('user:manage')
//   PATCH /api/users/:id/role            authenticateToken, csrfProtection, requirePermission('user:manage'), requireRecentAuth
//   POST /api/users/:id/deactivate       authenticateToken, csrfProtection, requirePermission('user:manage'), requireRecentAuth
//   POST /api/users/:id/reactivate       authenticateToken, csrfProtection, requirePermission('user:manage'), requireRecentAuth
//   PATCH /api/users/:id/job-title       authenticateToken, csrfProtection, requirePermission('user:manage')
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: packageJson.version });
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

app.get('/api/forecast/published', authenticateToken, requirePermission('forecast:view'), async (req, res) => {
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

// Permission check — used after authenticateToken. Looks up the caller's
// role and that role's permissions fresh from the database on every
// request (users -> roles -> role_permissions -> permissions), rather
// than trusting anything cached, so a deactivated account or a permission
// removed since the session was created takes effect immediately. Deny by
// default: no user, an unknown permission code, or a database error all
// mean no access — a database error is the one case that isn't a plain
// 403, since it's not actually known whether the user has the permission
// or not; it's reported as a 500 with an ERR reference instead of ever
// allowing the request through.
function requirePermission(code) {
  return async (req, res, next) => {
    const userId = req.user && req.user.user_id ? req.user.user_id : null;

    const deny = async () => {
      // A failure to write this audit row must never change the 403
      // response below — it's best-effort visibility, not a gate.
      try {
        await insertAuditLog(pool, {
          userId,
          action: 'permission.denied',
          details: { permission: code, method: req.method, path: req.path },
          ip: req.ip,
        });
      } catch (auditErr) {
        console.error('Failed to write permission.denied audit row:', auditErr);
      }
      return res.status(403).json({ error: "You don't have permission to do this." });
    };

    if (!userId) {
      return deny();
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
        [userId, code]
      );

      if (result.rows.length === 0) {
        return deny();
      }

      next();
    } catch (err) {
      const reference = generateErrorReference();
      console.error(`[${reference}] requirePermission(${code}) failed:`, err);
      res.status(500).json({ error: 'Unable to verify permissions right now.', reference });
    }
  };
}

// ---------------------------------------------------------------------------
// Sessions (Module 1, Part 2A)
// ---------------------------------------------------------------------------

async function insertAuditLog(queryable, { userId = null, action, entity = null, entityId = null, details = {}, ip = null }) {
  await queryable.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, entity, entityId, details, ip]
  );
}

// Creates a session row and returns what the caller needs to set the
// cookie and respond — never returns the raw session id to anything but
// the immediate caller (it goes straight into the cookie, nothing else).
async function createSession(queryable, { userId, roleName, ip }) {
  const rawSessionId = auth.generateSessionId();
  const sessionIdHash = auth.hashSessionId(rawSessionId);
  const csrfToken = auth.generateCsrfToken();
  const now = new Date();
  const expiresAt = auth.computeSessionExpiry({ now, createdAt: now, roleName });

  await queryable.query(
    `INSERT INTO sessions (session_id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at, ip_address)
     VALUES ($1, $2, $3, $4, $4, $5, $6)`,
    [sessionIdHash, userId, csrfToken, now, expiresAt, ip]
  );

  return { rawSessionId, csrfToken, expiresAt };
}

function setSessionCookie(res, rawSessionId, expiresAt) {
  res.cookie(
    'sid',
    rawSessionId,
    auth.getSessionCookieOptions({ production: IS_PRODUCTION, maxAgeMs: expiresAt.getTime() - Date.now() })
  );
}

// Shared payload for GET /api/me and every login route's response body.
async function getMePayload(queryable, userId) {
  const userResult = await queryable.query(
    `SELECT u.user_id, u.name, u.email, u.job_title, r.name AS role, r.display_name AS role_label
     FROM users u
     LEFT JOIN roles r ON r.role_id = u.role_id
     WHERE u.user_id = $1`,
    [userId]
  );
  const userRow = userResult.rows[0];
  if (!userRow) {
    return null;
  }

  const permissionsResult = await queryable.query(
    `SELECT p.code
     FROM users u
     JOIN role_permissions rp ON rp.role_id = u.role_id
     JOIN permissions p ON p.permission_id = rp.permission_id
     WHERE u.user_id = $1`,
    [userId]
  );

  return {
    user_id: userRow.user_id,
    name: userRow.name,
    email: userRow.email,
    job_title: userRow.job_title,
    role: userRow.role,
    role_label: userRow.role_label,
    permissions: permissionsResult.rows.map((row) => row.code),
  };
}

app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const mePayload = await getMePayload(pool, req.user.user_id);
    if (!mePayload) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    if (req.session) {
      mePayload.csrf_token = req.session.csrf_token;
      mePayload.session_expires_at = req.session.expires_at;
    }
    res.json(mePayload);
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] GET /api/me failed:`, err);
    res.status(500).json({ error: 'Unable to load your account right now.', reference });
  }
});

// The caller's own last 10 sign-ins (Google or emergency) — never another
// user's rows, since it's always scoped to req.user.user_id, never a
// user_id from the request.
app.get('/api/me/sign-ins', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT occurred_at, action, ip_address
       FROM audit_log
       WHERE user_id = $1 AND action IN ('login.success', 'emergency.login')
       ORDER BY occurred_at DESC
       LIMIT 10`,
      [req.user.user_id]
    );
    res.json({
      sign_ins: result.rows.map((row) => ({
        time: row.occurred_at,
        method: row.action === 'emergency.login' ? 'Emergency' : 'Google',
        ip_address: row.ip_address,
      })),
    });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] GET /api/me/sign-ins failed:`, err);
    res.status(500).json({ error: 'Unable to load your sign-in history right now.', reference });
  }
});

// App version (backend/package.json) plus whatever's actually on record
// for the latest published forecast and the consumption data's date
// range — never invented, so either piece is simply omitted (null) if
// nothing has been published/loaded yet.
app.get('/api/about', authenticateToken, async (req, res) => {
  try {
    const forecastResult = await pool.query(
      `SELECT forecast_id, generated_at, model_name, horizon,
              TO_CHAR(train_start, 'YYYY-MM-DD') AS train_start,
              TO_CHAR(train_end, 'YYYY-MM-DD') AS train_end
       FROM forecasts
       WHERE kind = 'published'
       ORDER BY generated_at DESC
       LIMIT 1`
    );
    const forecastRow = forecastResult.rows[0] || null;

    const rangeResult = await pool.query(
      `SELECT TO_CHAR(MIN(date), 'YYYY-MM-DD') AS first_month, TO_CHAR(MAX(date), 'YYYY-MM-DD') AS last_month
       FROM izsu_consumption`
    );
    const rangeRow = rangeResult.rows[0];

    res.json({
      version: packageJson.version,
      data: rangeRow && rangeRow.first_month ? { first_month: rangeRow.first_month, last_month: rangeRow.last_month } : null,
      latest_forecast: forecastRow
        ? {
            forecast_id: forecastRow.forecast_id,
            published_at: forecastRow.generated_at,
            model_name: forecastRow.model_name,
            horizon: forecastRow.horizon,
            train_start: forecastRow.train_start,
            train_end: forecastRow.train_end,
          }
        : null,
    });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] GET /api/about failed:`, err);
    res.status(500).json({ error: 'Unable to load this information right now.', reference });
  }
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body;

  if (!process.env.GOOGLE_CLIENT_ID) {
    const reference = generateErrorReference();
    console.error(`[${reference}] POST /api/auth/google: GOOGLE_CLIENT_ID is not configured`);
    return res.status(500).json({ error: 'Google sign-in is not configured right now.', reference });
  }

  if (!credential) {
    return res.status(400).json({ error: 'credential is required.' });
  }

  const REFUSAL_MESSAGE = "This Google account isn't authorised for this system. Contact your administrator.";

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    await insertAuditLog(pool, {
      action: 'login.failure',
      entity: 'users',
      details: { reason: 'invalid_token' },
      ip: req.ip,
    });
    return res.status(401).json({ error: REFUSAL_MESSAGE });
  }

  if (!payload || !payload.email_verified) {
    await insertAuditLog(pool, {
      action: 'login.failure',
      entity: 'users',
      details: { reason: 'email_not_verified', email: payload ? payload.email : null },
      ip: req.ip,
    });
    return res.status(401).json({ error: REFUSAL_MESSAGE });
  }

  const googleSub = payload.sub;
  const email = (payload.email || '').toLowerCase();

  try {
    // Find by google_sub first, else by email — two separate lookups
    // (not one OR query) so each is unambiguous about which identity it
    // matched on.
    let userRow = null;
    const bySubResult = await pool.query(
      `SELECT u.user_id, r.name AS role, u.status, u.auth_provider, u.google_sub
       FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
       WHERE u.google_sub = $1`,
      [googleSub]
    );
    if (bySubResult.rows.length > 0) {
      userRow = bySubResult.rows[0];
    } else {
      const byEmailResult = await pool.query(
        `SELECT u.user_id, r.name AS role, u.status, u.auth_provider, u.google_sub
         FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
         WHERE lower(u.email) = $1`,
        [email]
      );
      if (byEmailResult.rows.length > 0) {
        userRow = byEmailResult.rows[0];
      }
    }

    const refusalReason = !userRow
      ? 'not_found'
      : userRow.status === 'deactivated'
      ? 'deactivated'
      : userRow.auth_provider !== 'google'
      ? 'wrong_provider'
      : userRow.google_sub && userRow.google_sub !== googleSub
      ? 'sub_mismatch'
      : null;

    if (refusalReason) {
      await insertAuditLog(pool, {
        action: 'login.failure',
        entity: 'users',
        entityId: userRow ? String(userRow.user_id) : null,
        details: { reason: refusalReason, email },
        ip: req.ip,
      });
      return res.status(401).json({ error: REFUSAL_MESSAGE });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `UPDATE users
         SET google_sub = $1,
             status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
             last_login_at = now()
         WHERE user_id = $2`,
        [googleSub, userRow.user_id]
      );

      const { rawSessionId, csrfToken, expiresAt } = await createSession(client, {
        userId: userRow.user_id,
        roleName: userRow.role,
        ip: req.ip,
      });

      await insertAuditLog(client, {
        userId: userRow.user_id,
        action: 'login.success',
        entity: 'users',
        entityId: String(userRow.user_id),
        details: { email },
        ip: req.ip,
      });

      await client.query('COMMIT');

      setSessionCookie(res, rawSessionId, expiresAt);
      const mePayload = await getMePayload(pool, userRow.user_id);
      res.json({ ...mePayload, csrf_token: csrfToken, session_expires_at: expiresAt });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] POST /api/auth/google failed:`, err);
    res.status(500).json({ error: 'Unable to sign in right now.', reference });
  }
});

app.post('/api/auth/emergency-login', async (req, res) => {
  const { email: rawEmail, password } = req.body;
  const ip = req.ip;

  if (!rawEmail || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const email = rawEmail.trim().toLowerCase();
  const GENERIC_FAILURE_MESSAGE = 'Invalid email or password';

  try {
    const windowStart = new Date(Date.now() - auth.FAILED_LOGIN_WINDOW_MS);
    const attemptsResult = await pool.query(
      `SELECT COUNT(*) AS failed_count FROM login_attempts
       WHERE ip_address = $1 AND attempted_at >= $2 AND succeeded = false`,
      [ip, windowStart]
    );
    const failedCount = Number(attemptsResult.rows[0].failed_count);

    if (auth.isBlockedByFailedAttempts(failedCount)) {
      // Deliberately does not record this request in login_attempts and
      // never looks at the password — recording it would let an attacker
      // (or a shared-IP neighbor) keep the window perpetually topped up.
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }

    const userResult = await pool.query(
      `SELECT u.user_id, u.name, u.email, u.password, r.name AS role, u.status
       FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
       WHERE lower(u.email) = $1 AND u.auth_provider = 'emergency'`,
      [email]
    );
    const user = userResult.rows[0];
    const passwordMatches = user && user.password ? bcrypt.compareSync(password, user.password) : false;

    if (!user || !passwordMatches || user.status !== 'active') {
      await pool.query(`INSERT INTO login_attempts (ip_address, succeeded) VALUES ($1, false)`, [ip]);
      await insertAuditLog(pool, {
        userId: user ? user.user_id : null,
        action: 'emergency.login_failed',
        entity: 'users',
        entityId: user ? String(user.user_id) : null,
        details: { email },
        ip,
      });
      return res.status(401).json({ error: GENERIC_FAILURE_MESSAGE });
    }

    await pool.query(`INSERT INTO login_attempts (ip_address, succeeded) VALUES ($1, true)`, [ip]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`UPDATE users SET last_login_at = now() WHERE user_id = $1`, [user.user_id]);

      const { rawSessionId, csrfToken, expiresAt } = await createSession(client, {
        userId: user.user_id,
        roleName: user.role,
        ip,
      });

      await insertAuditLog(client, {
        userId: user.user_id,
        action: 'emergency.login',
        entity: 'users',
        entityId: String(user.user_id),
        details: { email, severity: 'warning', note: 'Change the emergency admin password soon.' },
        ip,
      });

      await client.query('COMMIT');

      setSessionCookie(res, rawSessionId, expiresAt);
      const mePayload = await getMePayload(pool, user.user_id);
      res.json({ ...mePayload, csrf_token: csrfToken, session_expires_at: expiresAt });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] POST /api/auth/emergency-login failed:`, err);
    res.status(500).json({ error: 'Unable to sign in right now.', reference });
  }
});

app.post('/api/auth/logout', authenticateToken, csrfProtection, async (req, res) => {
  try {
    if (req.session) {
      await pool.query('DELETE FROM sessions WHERE session_id_hash = $1', [req.session.id_hash]);
      res.clearCookie('sid', auth.getSessionCookieOptions({ production: IS_PRODUCTION, maxAgeMs: 0 }));
    }

    await insertAuditLog(pool, {
      userId: req.user.user_id,
      action: 'logout',
      entity: 'users',
      entityId: String(req.user.user_id),
      ip: req.ip,
    });

    res.status(204).end();
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] POST /api/auth/logout failed:`, err);
    res.status(500).json({ error: 'Unable to log out right now.', reference });
  }
});

app.get('/api/consumption-history', authenticateToken, requirePermission('data:view'), async (req, res) => {
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

app.post(
  '/api/production/plan',
  authenticateToken,
  csrfProtection,
  requirePermission('plan:create'),
  async (req, res) => {
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

app.post(
  '/api/production/stock',
  authenticateToken,
  csrfProtection,
  requirePermission('stock:create'),
  async (req, res) => {
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

// ---------------------------------------------------------------------------
// Demand by District (Module 4) — district-level split of the published
// forecast, for Production Planners ("distribution:view").
// ---------------------------------------------------------------------------

app.get('/api/distribution', authenticateToken, requirePermission('distribution:view'), async (req, res) => {
  try {
    const forecast = await getLatestPublishedForecast(pool);
    if (!forecast) {
      return res.status(404).json({ error: 'No forecast has been published yet.' });
    }

    const lossRate = await getLossRate(pool);
    const forecastMonths = await getForecastMonths(pool, forecast.forecast_id);
    const activePlansByMonth = await getActivePlansByMonth(pool, forecast.forecast_id);

    // Summed over customer_group/subscriber_type here, once, rather than
    // in every pure-function call that needs a district's monthly total.
    const consumptionResult = await pool.query(
      `SELECT EXTRACT(YEAR FROM year_month)::int AS year,
              EXTRACT(MONTH FROM year_month)::int AS month,
              district,
              SUM(consumption_m3)::double precision AS consumption_m3
       FROM consumption_detail
       GROUP BY year, month, district`
    );
    const consumptionRows = consumptionResult.rows;
    const districts = distribution.listDistricts(consumptionRows);

    const latestMonthResult = await pool.query(
      `SELECT TO_CHAR(MAX(year_month), 'YYYY-MM-DD') AS month FROM consumption_detail`
    );
    const subscribersMonth = latestMonthResult.rows[0].month;
    const subscribersByDistrict = new Map();
    if (subscribersMonth) {
      const subscribersResult = await pool.query(
        `SELECT district, SUM(subscribers)::int AS subscribers
         FROM consumption_detail
         WHERE year_month = $1::date
         GROUP BY district`,
        [subscribersMonth]
      );
      subscribersResult.rows.forEach((row) => subscribersByDistrict.set(row.district, row.subscribers));
    }

    const swing = distribution.computeSeasonalSwing(consumptionRows, districts);

    const months = forecastMonths.map((row) => {
      const calendarMonth = Number(row.date.slice(5, 7));
      const activePlan = activePlansByMonth.get(row.date);
      const planChosenM3 = activePlan ? activePlan.chosen_m3 : null;

      const { shareYears, changeYears, rows: districtRows } = distribution.buildDistrictBreakdown({
        consumptionRows,
        districts,
        calendarMonth,
        forecastM3: row.predicted_value,
        lowerM3: row.yhat_lower,
        upperM3: row.yhat_upper,
        planChosenM3,
      });

      return {
        month: row.date,
        share_years: shareYears,
        change_years: changeYears,
        plan_type: activePlan ? activePlan.plan_type : null,
        plan_chosen_m3: planChosenM3,
        districts: districtRows.map((d) => ({
          ...d,
          subscribers: subscribersByDistrict.get(d.district) ?? null,
        })),
      };
    });

    res.json({
      forecast_id: forecast.forecast_id,
      published_at: forecast.generated_at,
      data_up_to: forecast.data_up_to,
      loss_rate: lossRate ? lossRate.value : null,
      loss_rate_source: lossRate ? lossRate.source : null,
      districts,
      subscribers_month: subscribersMonth,
      swing,
      months,
    });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] /api/distribution failed:`, err);
    res.status(500).json({ error: 'Unable to load district demand right now.', reference });
  }
});

// ---------------------------------------------------------------------------
// Users (Module 1, Part 4) — admin-only account management.
// ---------------------------------------------------------------------------

async function countOtherActiveAdmins(queryable, excludeUserId) {
  const result = await queryable.query(
    `SELECT COUNT(*) AS count
     FROM users u
     JOIN roles r ON r.role_id = u.role_id
     WHERE r.name = 'admin' AND u.status = 'active' AND u.user_id != $1`,
    [excludeUserId]
  );
  return Number(result.rows[0].count);
}

// The same shape for every route that returns a user: GET /api/users'
// list items, and the updated row after a role change, deactivation or
// reactivation.
function serializeUserRow(row) {
  return {
    user_id: row.user_id,
    name: row.name,
    email: row.email,
    job_title: row.job_title,
    role: row.role,
    role_label: row.role_label,
    status: row.status,
    auth_provider: row.auth_provider,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
    deactivation_reason: row.deactivation_reason,
  };
}

// The full role catalog (name/code + display_name) — lets the frontend
// populate role selects/filters without ever hard-coding a role's label,
// including a role no current user happens to have yet.
app.get('/api/roles', authenticateToken, requirePermission('user:manage'), async (req, res) => {
  try {
    const result = await pool.query(`SELECT name, display_name FROM roles ORDER BY display_name`);
    res.json(result.rows);
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] GET /api/roles failed:`, err);
    res.status(500).json({ error: 'Unable to load roles right now.', reference });
  }
});

app.get('/api/users', authenticateToken, requirePermission('user:manage'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.user_id, u.name, u.email, u.job_title, r.name AS role, r.display_name AS role_label,
              u.status, u.auth_provider, u.last_login_at, u.created_at, u.deactivation_reason
       FROM users u
       LEFT JOIN roles r ON r.role_id = u.role_id
       ORDER BY u.name`
    );
    res.json({ users: result.rows.map(serializeUserRow) });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] GET /api/users failed:`, err);
    res.status(500).json({ error: 'Unable to load users right now.', reference });
  }
});

app.post('/api/users', authenticateToken, csrfProtection, requirePermission('user:manage'), async (req, res) => {
  const { valid, errors, name, email, job_title: jobTitle } = users.validateInviteRequest(req.body || {});
  if (!valid) {
    return res.status(400).json({ error: 'Validation failed.', fields: errors });
  }
  const roleName = req.body.role;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Case-insensitive duplicate check — the same rule invite_user.py
    // uses. users.email also has a plain UNIQUE constraint (000), which
    // the catch block below falls back on for a same-casing race.
    const existingResult = await client.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email]);
    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }

    const roleResult = await client.query(`SELECT role_id, display_name FROM roles WHERE name = $1`, [roleName]);
    if (roleResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Validation failed.', fields: { role: 'Choose a valid role.' } });
    }
    const { role_id: roleId, display_name: roleLabel } = roleResult.rows[0];

    const insertResult = await client.query(
      `INSERT INTO users (name, email, password, role_id, status, auth_provider, job_title)
       VALUES ($1, $2, NULL, $3, 'invited', 'google', $4)
       RETURNING user_id, created_at`,
      [name, email, roleId, jobTitle]
    );
    const newUser = insertResult.rows[0];

    await insertAuditLog(client, {
      userId: req.user.user_id,
      action: 'user.invited',
      entity: 'users',
      entityId: String(newUser.user_id),
      details: { email, role: roleName },
      ip: req.ip,
    });

    await client.query('COMMIT');

    res.status(201).json(
      serializeUserRow({
        user_id: newUser.user_id,
        name,
        email,
        job_title: jobTitle,
        role: roleName,
        role_label: roleLabel,
        status: 'invited',
        auth_provider: 'google',
        last_login_at: null,
        created_at: newUser.created_at,
        deactivation_reason: null,
      })
    );
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A user with this email already exists.' });
    }
    const reference = generateErrorReference();
    console.error(`[${reference}] POST /api/users failed:`, err);
    res.status(500).json({ error: 'Unable to invite this user right now.', reference });
  } finally {
    client.release();
  }
});

app.patch(
  '/api/users/:id/role',
  authenticateToken,
  csrfProtection,
  requirePermission('user:manage'),
  requireRecentAuth,
  async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId)) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (targetId === req.user.user_id) {
      return res.status(403).json({ error: "You can't change your own role." });
    }

    const { valid, errors } = users.validateRoleChangeRequest(req.body || {});
    if (!valid) {
      return res.status(400).json({ error: 'Validation failed.', fields: errors });
    }
    const newRoleName = req.body.role;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const targetResult = await client.query(
        `SELECT u.user_id, u.name, u.email, u.job_title, u.status, u.auth_provider, u.last_login_at, u.created_at,
                u.deactivation_reason, r.name AS current_role
         FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
         WHERE u.user_id = $1
         FOR UPDATE OF u`,
        [targetId]
      );
      const target = targetResult.rows[0];
      if (!target) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found.' });
      }
      if (target.auth_provider === 'emergency') {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: "Emergency accounts can't be changed here." });
      }

      const roleResult = await client.query(`SELECT role_id, display_name FROM roles WHERE name = $1`, [newRoleName]);
      if (roleResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Validation failed.', fields: { role: 'Choose a valid role.' } });
      }
      const { role_id: newRoleId, display_name: newRoleLabel } = roleResult.rows[0];

      const otherActiveAdminCount = await countOtherActiveAdmins(client, targetId);
      if (
        users.wouldRemoveLastActiveAdmin({
          currentRole: target.current_role,
          currentStatus: target.status,
          newRole: newRoleName,
          otherActiveAdminCount,
        })
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'There must be at least one active Admin.' });
      }

      await client.query(`UPDATE users SET role_id = $1 WHERE user_id = $2`, [newRoleId, targetId]);

      await insertAuditLog(client, {
        userId: req.user.user_id,
        action: 'user.role_changed',
        entity: 'users',
        entityId: String(targetId),
        details: { from: target.current_role, to: newRoleName },
        ip: req.ip,
      });

      await client.query('COMMIT');

      res.json(
        serializeUserRow({
          user_id: targetId,
          name: target.name,
          email: target.email,
          job_title: target.job_title,
          role: newRoleName,
          role_label: newRoleLabel,
          status: target.status,
          auth_provider: target.auth_provider,
          last_login_at: target.last_login_at,
          created_at: target.created_at,
          deactivation_reason: target.deactivation_reason,
        })
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback failed:', rollbackErr);
      }
      const reference = generateErrorReference();
      console.error(`[${reference}] PATCH /api/users/:id/role failed:`, err);
      res.status(500).json({ error: 'Unable to change this role right now.', reference });
    } finally {
      client.release();
    }
  }
);

app.post(
  '/api/users/:id/deactivate',
  authenticateToken,
  csrfProtection,
  requirePermission('user:manage'),
  requireRecentAuth,
  async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId)) {
      return res.status(404).json({ error: 'User not found.' });
    }
    if (targetId === req.user.user_id) {
      return res.status(403).json({ error: "You can't deactivate your own account." });
    }

    const { valid, error: reasonError, trimmed: reason } = users.validateDeactivationReason(
      req.body && req.body.reason
    );
    if (!valid) {
      return res.status(400).json({ error: 'Validation failed.', fields: { reason: reasonError } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const targetResult = await client.query(
        `SELECT u.user_id, u.name, u.email, u.job_title, u.auth_provider, u.last_login_at, u.created_at,
                u.status, r.name AS current_role, r.display_name AS role_label
         FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
         WHERE u.user_id = $1
         FOR UPDATE OF u`,
        [targetId]
      );
      const target = targetResult.rows[0];
      if (!target) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found.' });
      }

      const otherActiveAdminCount = await countOtherActiveAdmins(client, targetId);
      if (
        users.wouldDeactivateLastActiveAdmin({
          currentRole: target.current_role,
          currentStatus: target.status,
          otherActiveAdminCount,
        })
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'There must be at least one active Admin.' });
      }

      await client.query(
        `UPDATE users SET status = 'deactivated', deactivated_at = now(), deactivation_reason = $1 WHERE user_id = $2`,
        [reason, targetId]
      );
      await client.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);

      await insertAuditLog(client, {
        userId: req.user.user_id,
        action: 'user.deactivated',
        entity: 'users',
        entityId: String(targetId),
        details: { reason },
        ip: req.ip,
      });

      await client.query('COMMIT');

      res.json(
        serializeUserRow({
          user_id: targetId,
          name: target.name,
          email: target.email,
          job_title: target.job_title,
          role: target.current_role,
          role_label: target.role_label,
          status: 'deactivated',
          auth_provider: target.auth_provider,
          last_login_at: target.last_login_at,
          created_at: target.created_at,
          deactivation_reason: reason,
        })
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback failed:', rollbackErr);
      }
      const reference = generateErrorReference();
      console.error(`[${reference}] POST /api/users/:id/deactivate failed:`, err);
      res.status(500).json({ error: 'Unable to deactivate this user right now.', reference });
    } finally {
      client.release();
    }
  }
);

app.post(
  '/api/users/:id/reactivate',
  authenticateToken,
  csrfProtection,
  requirePermission('user:manage'),
  requireRecentAuth,
  async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId)) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const { valid, error: reasonError, trimmed: reason } = users.validateReactivationReason(
      req.body && req.body.reason
    );
    if (!valid) {
      return res.status(400).json({ error: 'Validation failed.', fields: { reason: reasonError } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const targetResult = await client.query(
        `SELECT u.user_id, u.name, u.email, u.job_title, u.auth_provider, u.last_login_at, u.created_at,
                u.deactivation_reason, u.status, u.google_sub, r.name AS current_role, r.display_name AS role_label
         FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
         WHERE u.user_id = $1
         FOR UPDATE OF u`,
        [targetId]
      );
      const target = targetResult.rows[0];
      if (!target) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found.' });
      }
      if (target.status !== 'deactivated') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `This account is already ${target.status}.` });
      }

      const newStatus = target.google_sub ? 'active' : 'invited';
      await client.query(`UPDATE users SET status = $1, deactivated_at = NULL WHERE user_id = $2`, [
        newStatus,
        targetId,
      ]);

      await insertAuditLog(client, {
        userId: req.user.user_id,
        action: 'user.reactivated',
        entity: 'users',
        entityId: String(targetId),
        details: { reason, new_status: newStatus },
        ip: req.ip,
      });

      await client.query('COMMIT');

      res.json(
        serializeUserRow({
          user_id: targetId,
          name: target.name,
          email: target.email,
          job_title: target.job_title,
          role: target.current_role,
          role_label: target.role_label,
          status: newStatus,
          auth_provider: target.auth_provider,
          last_login_at: target.last_login_at,
          created_at: target.created_at,
          deactivation_reason: target.deactivation_reason,
        })
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback failed:', rollbackErr);
      }
      const reference = generateErrorReference();
      console.error(`[${reference}] POST /api/users/:id/reactivate failed:`, err);
      res.status(500).json({ error: 'Unable to reactivate this user right now.', reference });
    } finally {
      client.release();
    }
  }
);

// No requireRecentAuth here, unlike role/deactivate/reactivate — a job
// title is descriptive text, not a security-relevant change, so it isn't
// gated behind a fresh sign-in.
app.patch(
  '/api/users/:id/job-title',
  authenticateToken,
  csrfProtection,
  requirePermission('user:manage'),
  async (req, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId)) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const { valid, error: jobTitleError, trimmed: jobTitle } = users.validateJobTitle(
      req.body && req.body.job_title
    );
    if (!valid) {
      return res.status(400).json({ error: 'Validation failed.', fields: { job_title: jobTitleError } });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const targetResult = await client.query(
        `SELECT u.user_id, u.name, u.email, u.status, u.auth_provider, u.last_login_at, u.created_at,
                u.deactivation_reason, r.name AS current_role, r.display_name AS role_label
         FROM users u LEFT JOIN roles r ON r.role_id = u.role_id
         WHERE u.user_id = $1
         FOR UPDATE OF u`,
        [targetId]
      );
      const target = targetResult.rows[0];
      if (!target) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found.' });
      }

      await client.query(`UPDATE users SET job_title = $1 WHERE user_id = $2`, [jobTitle, targetId]);

      await insertAuditLog(client, {
        userId: req.user.user_id,
        action: 'user.job_title_changed',
        entity: 'users',
        entityId: String(targetId),
        details: { job_title: jobTitle },
        ip: req.ip,
      });

      await client.query('COMMIT');

      res.json(
        serializeUserRow({
          user_id: targetId,
          name: target.name,
          email: target.email,
          job_title: jobTitle,
          role: target.current_role,
          role_label: target.role_label,
          status: target.status,
          auth_provider: target.auth_provider,
          last_login_at: target.last_login_at,
          created_at: target.created_at,
          deactivation_reason: target.deactivation_reason,
        })
      );
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Rollback failed:', rollbackErr);
      }
      const reference = generateErrorReference();
      console.error(`[${reference}] PATCH /api/users/:id/job-title failed:`, err);
      res.status(500).json({ error: 'Unable to update this job title right now.', reference });
    } finally {
      client.release();
    }
  }
);

// ---------------------------------------------------------------------------
// Revenue Estimate (Module 5) — billed revenue split by (district,
// subscriber_type) cell, priced through the latest published tariff, for
// Commercial Analysts ("revenue:view").
// ---------------------------------------------------------------------------

app.get('/api/revenue', authenticateToken, requirePermission('revenue:view'), async (req, res) => {
  try {
    const forecast = await getLatestPublishedForecast(pool);
    if (!forecast) {
      return res.status(404).json({ error: 'No forecast has been published yet.' });
    }

    const forecastMonths = await getForecastMonths(pool, forecast.forecast_id);

    // Summed over any duplicate (district, subscriber_type) rows for the
    // same month — defensive, same caution as Module 4's district total.
    const consumptionResult = await pool.query(
      `SELECT EXTRACT(YEAR FROM year_month)::int AS year,
              EXTRACT(MONTH FROM year_month)::int AS month,
              district, subscriber_type,
              SUM(consumption_m3)::double precision AS consumption_m3
       FROM consumption_detail
       GROUP BY year, month, district, subscriber_type`
    );
    const consumptionRows = consumptionResult.rows;
    const cells = revenue.listCells(consumptionRows);

    const latestMonthResult = await pool.query(
      `SELECT TO_CHAR(MAX(year_month), 'YYYY-MM-DD') AS month FROM consumption_detail`
    );
    const subscribersMonth = latestMonthResult.rows[0].month;

    const subscribersByCell = new Map();
    if (subscribersMonth) {
      const subscribersResult = await pool.query(
        `SELECT district, subscriber_type, SUM(subscribers)::int AS subscribers
         FROM consumption_detail
         WHERE year_month = $1::date
         GROUP BY district, subscriber_type`,
        [subscribersMonth]
      );
      subscribersResult.rows.forEach((row) => {
        subscribersByCell.set(revenue.cellKey(row.district, row.subscriber_type), row.subscribers);
      });
    }

    // Looked up across every month in consumption_detail, not just
    // subscribersMonth — a subscriber_type/district cell can be absent
    // from the latest month (no subscribers that month) while still
    // appearing in earlier months, and it belongs to the same
    // customer_group regardless of which month you check. Scoping this
    // to subscribersMonth was dropping those cells to "Unknown".
    const customerGroupByKey = new Map();
    const customerGroupResult = await pool.query(
      // (array_agg(customer_group))[1]: a subscriber_type is expected to
      // belong to exactly one customer_group, but this picks one value
      // rather than assuming it rather than crashing if that ever isn't so.
      `SELECT district, subscriber_type, (array_agg(customer_group))[1] AS customer_group
       FROM consumption_detail
       GROUP BY district, subscriber_type`
    );
    customerGroupResult.rows.forEach((row) => {
      customerGroupByKey.set(revenue.cellKey(row.district, row.subscriber_type), row.customer_group);
    });

    const tariffTypeMapResult = await pool.query(`SELECT consumption_type, tariff_type FROM tariff_type_map`);
    const consumptionTypeToTariffType = new Map(
      tariffTypeMapResult.rows.map((row) => [row.consumption_type, row.tariff_type])
    );

    // Always the latest tariff version (1 Jul 2024), regardless of which
    // forecast month is being priced.
    const latestTariffDateResult = await pool.query(
      `SELECT TO_CHAR(MAX(valid_from), 'YYYY-MM-DD') AS valid_from FROM tariffs`
    );
    const tariffVersionDate = latestTariffDateResult.rows[0].valid_from;

    let tariffCatalog = new Map();
    if (tariffVersionDate) {
      const tariffRowsResult = await pool.query(
        `SELECT subscriber_type, band_min_m3, band_max_m3, price_per_m3, wastewater_price_per_m3
         FROM tariffs
         WHERE valid_from = $1::date
         ORDER BY subscriber_type, band_min_m3`,
        [tariffVersionDate]
      );
      tariffCatalog = revenue.buildTariffCatalog(tariffRowsResult.rows);
    }

    // Read-only "Tariff in use" table: housing and workplace bands only,
    // pulled from the catalog just built rather than hardcoded here.
    const tariffsInUse = {};
    ['KONUT ABONELERİ', 'İŞYERİ ABONELERİ'].forEach((type) => {
      const entry = tariffCatalog.get(type);
      if (entry && !entry.ambiguous) {
        tariffsInUse[type] = entry.bands;
      }
    });

    const months = forecastMonths.map((row) => {
      const calendarMonth = Number(row.date.slice(5, 7));

      const {
        shareYears,
        cells: pricedCells,
        totals,
      } = revenue.buildRevenueBreakdown({
        consumptionRows,
        cells,
        calendarMonth,
        forecastM3: row.predicted_value,
        lowerM3: row.yhat_lower,
        upperM3: row.yhat_upper,
        subscribersByCell,
        consumptionTypeToTariffType,
        tariffCatalog,
      });

      const byGroup = revenue.buildGroupBreakdown(pricedCells, customerGroupByKey);
      const districtGroupDetail = revenue.buildDistrictGroupBreakdown(pricedCells, customerGroupByKey);

      return {
        month: row.date,
        share_years: shareYears,
        totals,
        by_group: byGroup,
        detail: districtGroupDetail,
      };
    });

    res.json({
      forecast_id: forecast.forecast_id,
      published_at: forecast.generated_at,
      data_up_to: forecast.data_up_to,
      subscribers_month: subscribersMonth,
      tariff_version_date: tariffVersionDate,
      tariffs_in_use: tariffsInUse,
      months,
    });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] /api/revenue failed:`, err);
    res.status(500).json({ error: 'Unable to load the revenue estimate right now.', reference });
  }
});

// Revenue Scenarios (Module 5b) — "what happens to revenue if prices
// change?" Same consumption/tariff/subscriber inputs GET /api/revenue
// already loads, re-priced under up to 2 scenarios via revenueScenarios.js
// (price-change multipliers + constant-elasticity demand response). Never
// saved — everything here is calculated live, per request.
app.post(
  '/api/revenue/scenario',
  authenticateToken,
  csrfProtection,
  requirePermission('revenue:view'),
  async (req, res) => {
    const { valid, errors, scenarios } = revenueScenarios.validateScenarioRequest(req.body || {});
    if (!valid) {
      return res.status(400).json({ error: 'Validation failed.', fields: errors });
    }

    try {
      const forecast = await getLatestPublishedForecast(pool);
      if (!forecast) {
        return res.status(404).json({ error: 'No forecast has been published yet.' });
      }

      const forecastMonths = await getForecastMonths(pool, forecast.forecast_id);

      const consumptionResult = await pool.query(
        `SELECT EXTRACT(YEAR FROM year_month)::int AS year,
                EXTRACT(MONTH FROM year_month)::int AS month,
                district, subscriber_type,
                SUM(consumption_m3)::double precision AS consumption_m3
         FROM consumption_detail
         GROUP BY year, month, district, subscriber_type`
      );
      const consumptionRows = consumptionResult.rows;
      const cells = revenue.listCells(consumptionRows);

      const latestMonthResult = await pool.query(
        `SELECT TO_CHAR(MAX(year_month), 'YYYY-MM-DD') AS month FROM consumption_detail`
      );
      const subscribersMonth = latestMonthResult.rows[0].month;

      const subscribersByCell = new Map();
      if (subscribersMonth) {
        const subscribersResult = await pool.query(
          `SELECT district, subscriber_type, SUM(subscribers)::int AS subscribers
           FROM consumption_detail
           WHERE year_month = $1::date
           GROUP BY district, subscriber_type`,
          [subscribersMonth]
        );
        subscribersResult.rows.forEach((row) => {
          subscribersByCell.set(revenue.cellKey(row.district, row.subscriber_type), row.subscribers);
        });
      }

      const tariffTypeMapResult = await pool.query(`SELECT consumption_type, tariff_type FROM tariff_type_map`);
      const consumptionTypeToTariffType = new Map(
        tariffTypeMapResult.rows.map((row) => [row.consumption_type, row.tariff_type])
      );

      // Same lookup GET /api/revenue uses: a cell's customer_group, from
      // consumption_detail across every month (not just subscribersMonth),
      // since a subscriber_type/district cell belongs to one customer_group
      // regardless of which month you check. This is what "housing" scope
      // means for demand response — the Konut customer_group, not the
      // KONUT ABONELERİ tariff type (those are different axes of a cell).
      const customerGroupByKey = new Map();
      const customerGroupResult = await pool.query(
        `SELECT district, subscriber_type, (array_agg(customer_group))[1] AS customer_group
         FROM consumption_detail
         GROUP BY district, subscriber_type`
      );
      customerGroupResult.rows.forEach((row) => {
        customerGroupByKey.set(revenue.cellKey(row.district, row.subscriber_type), row.customer_group);
      });

      const latestTariffDateResult = await pool.query(
        `SELECT TO_CHAR(MAX(valid_from), 'YYYY-MM-DD') AS valid_from FROM tariffs`
      );
      const tariffVersionDate = latestTariffDateResult.rows[0].valid_from;

      let tariffCatalog = new Map();
      if (tariffVersionDate) {
        const tariffRowsResult = await pool.query(
          `SELECT subscriber_type, band_min_m3, band_max_m3, price_per_m3, wastewater_price_per_m3
           FROM tariffs
           WHERE valid_from = $1::date
           ORDER BY subscriber_type, band_min_m3`,
          [tariffVersionDate]
        );
        tariffCatalog = revenue.buildTariffCatalog(tariffRowsResult.rows);
      }

      // Read-only band labels for the per-step inputs — pulled from the
      // same catalog, never hardcoded (band thresholds could change).
      const tariffsInUse = {};
      ['KONUT ABONELERİ', 'İŞYERİ ABONELERİ'].forEach((type) => {
        const entry = tariffCatalog.get(type);
        if (entry && !entry.ambiguous) {
          tariffsInUse[type] = entry.bands;
        }
      });

      const months = forecastMonths.map((row) => {
        const calendarMonth = Number(row.date.slice(5, 7));

        const { cells: baselineCells, totals: baselineTotals } = revenue.buildRevenueBreakdown({
          consumptionRows,
          cells,
          calendarMonth,
          forecastM3: row.predicted_value,
          lowerM3: row.yhat_lower,
          upperM3: row.yhat_upper,
          subscribersByCell,
          consumptionTypeToTariffType,
          tariffCatalog,
        });
        const baselineVolume = baselineCells.reduce((sum, c) => sum + c.volume_m3, 0);

        const scenarioMonths = scenarios.map((scenario) =>
          revenueScenarios.buildScenarioMonth({
            baselineCells,
            baselineTotals,
            tariffCatalog,
            consumptionTypeToTariffType,
            customerGroupByKey,
            scenario,
          })
        );

        return {
          month: row.date,
          baseline: {
            water: baselineTotals.water,
            wastewater: baselineTotals.wastewater,
            total: baselineTotals.total,
            volume_m3: baselineVolume,
            not_priced_pct: baselineTotals.not_priced_pct,
          },
          scenarios: scenarioMonths.map((m, i) => {
            const changeTry = revenue.round2(m.totals.total.mid - baselineTotals.total.mid);
            const changePct =
              baselineTotals.total.mid > 0 ? revenue.round2((changeTry / baselineTotals.total.mid) * 100) : null;
            return {
              name: scenarios[i].name,
              water: m.totals.water,
              wastewater: m.totals.wastewater,
              total: m.totals.total,
              volume_m3: m.totals.volume_m3,
              volume_change_m3: revenue.round2(m.totals.volume_m3 - baselineVolume),
              change_try: changeTry,
              change_pct: changePct,
              not_priced_pct: m.totals.not_priced_pct,
            };
          }),
        };
      });

      const sumTotals = (field) => ({
        mid: revenue.round2(months.reduce((s, m) => s + m.baseline[field].mid, 0)),
        low: revenue.round2(months.reduce((s, m) => s + m.baseline[field].low, 0)),
        high: revenue.round2(months.reduce((s, m) => s + m.baseline[field].high, 0)),
      });
      const twelveMonthBaseline = {
        water: sumTotals('water'),
        wastewater: sumTotals('wastewater'),
        total: sumTotals('total'),
        volume_m3: months.reduce((s, m) => s + m.baseline.volume_m3, 0),
      };
      const twelveMonthScenarios = scenarios.map((scenario, i) => {
        const sumScenario = (field) => ({
          mid: revenue.round2(months.reduce((s, m) => s + m.scenarios[i][field].mid, 0)),
          low: revenue.round2(months.reduce((s, m) => s + m.scenarios[i][field].low, 0)),
          high: revenue.round2(months.reduce((s, m) => s + m.scenarios[i][field].high, 0)),
        });
        const total = sumScenario('total');
        const volume_m3 = months.reduce((s, m) => s + m.scenarios[i].volume_m3, 0);
        const changeTry = revenue.round2(total.mid - twelveMonthBaseline.total.mid);
        const changePct =
          twelveMonthBaseline.total.mid > 0 ? revenue.round2((changeTry / twelveMonthBaseline.total.mid) * 100) : null;
        return {
          name: scenario.name,
          water: sumScenario('water'),
          wastewater: sumScenario('wastewater'),
          total,
          volume_m3,
          volume_change_m3: revenue.round2(volume_m3 - twelveMonthBaseline.volume_m3),
          change_try: changeTry,
          change_pct: changePct,
        };
      });

      res.json({
        forecast_id: forecast.forecast_id,
        published_at: forecast.generated_at,
        tariff_version_date: tariffVersionDate,
        tariffs_in_use: tariffsInUse,
        scenarios: scenarios.map((s) => ({
          name: s.name,
          mode: s.mode,
          elasticity: s.elasticity,
          elasticity_scope: s.elasticity_scope,
          note: s.note,
        })),
        months,
        twelve_month_totals: {
          baseline: twelveMonthBaseline,
          scenarios: twelveMonthScenarios,
        },
      });
    } catch (err) {
      const reference = generateErrorReference();
      console.error(`[${reference}] POST /api/revenue/scenario failed:`, err);
      res.status(500).json({ error: 'Unable to calculate these scenarios right now.', reference });
    }
  }
);

// ---------------------------------------------------------------------------
// Overview (Module 6) — the role-based landing page after sign-in. One
// route, authenticateToken only: each section below is built only if the
// signed-in user actually holds that section's permission (checked
// against mePayload.permissions, fetched fresh the same way GET /api/me
// does), so a role never sees a section — or an alert linking to one —
// that its own other routes would 403 it out of. All the maths reuses
// the same helpers/pure functions the other modules already use; only
// the SQL that fetches rows for them is repeated here, same as every
// other route in this file already does for itself.
// ---------------------------------------------------------------------------

// Plain-language label for an audit_log action code, for the "5 most
// recent events" list — the stored code itself is also returned, so the
// frontend/CSV always has the raw value too, not just this gloss.
const AUDIT_ACTION_LABELS = {
  'login.success': 'Signed in',
  'login.failure': 'Failed sign-in attempt',
  'emergency.login': 'Emergency sign-in',
  'emergency.login_failed': 'Failed emergency sign-in',
  logout: 'Signed out',
  'permission.denied': 'Permission denied',
  'user.invited': 'Invited a user',
  'user.role_changed': 'Changed a role',
  'user.deactivated': 'Deactivated a user',
  'user.reactivated': 'Reactivated a user',
  'user.job_title_changed': 'Changed a job title',
  'plan.save': 'Saved a production plan',
  'stock.record': 'Recorded stock',
};

// 'YYYY-MM-DD' -> 'November 2026', for alert text only — never used to
// compute anything, so there's no risk of this disagreeing with the date
// value itself returned alongside it.
function monthLongLabel(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

app.get('/api/overview', authenticateToken, async (req, res) => {
  try {
    const mePayload = await getMePayload(pool, req.user.user_id);
    if (!mePayload) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    const permissions = new Set(mePayload.permissions);
    const sections = {};
    const alerts = [];

    const forecast = await getLatestPublishedForecast(pool);
    const forecastMonths = forecast ? await getForecastMonths(pool, forecast.forecast_id) : [];
    const firstMonthRow = forecastMonths[0] || null;

    // Forecast dates (not the predicted values) are already exposed to
    // every authenticated user regardless of permission via GET
    // /api/about, so showing them unconditionally here too isn't a new
    // leak — only the actual predicted/lower/upper numbers stay gated
    // behind forecast:view, in sections.forecast below.
    const firstMonth = firstMonthRow ? firstMonthRow.date : null;
    const dataUpTo = forecast ? forecast.data_up_to : null;
    const publishedAt = forecast ? forecast.generated_at : null;

    if (permissions.has('forecast:view') && firstMonthRow) {
      sections.forecast = {
        first_month: firstMonthRow.date,
        predicted: firstMonthRow.predicted_value,
        lower: firstMonthRow.yhat_lower,
        upper: firstMonthRow.yhat_upper,
        published_at: forecast.generated_at,
        data_up_to: forecast.data_up_to,
      };
    }

    if (permissions.has('plan:view') && forecast && firstMonthRow) {
      const activePlansByMonth = await getActivePlansByMonth(pool, forecast.forecast_id);
      const nextMonths = forecastMonths.slice(0, 3).map((row) => {
        const activePlan = activePlansByMonth.get(row.date);
        return {
          month: row.date,
          plan: activePlan ? { plan_type: activePlan.plan_type, chosen_m3: activePlan.chosen_m3 } : null,
        };
      });

      const stockResult = await pool.query(
        `SELECT TO_CHAR(recorded_on, 'YYYY-MM-DD') AS recorded_on, stock_m3::double precision AS stock_m3
         FROM stock_entries
         ORDER BY recorded_on DESC, entry_id DESC
         LIMIT 1`
      );
      const latestStock = stockResult.rows[0] || null;

      let daysOfCover = null;
      const firstMonthPlan = nextMonths[0] ? nextMonths[0].plan : null;
      if (latestStock && firstMonthPlan) {
        const [year, month] = firstMonthRow.date.split('-').map(Number);
        const daysInFirstMonth = planning.daysInMonth(year, month);
        daysOfCover = planning.calculateDaysOfCover(latestStock.stock_m3, firstMonthPlan.chosen_m3, daysInFirstMonth);
      }

      const daysSinceStock = latestStock
        ? Math.floor((Date.now() - new Date(`${latestStock.recorded_on}T00:00:00Z`).getTime()) / 86_400_000)
        : null;

      // The full forecast horizon (not just the next 3 months) — only
      // what the chart needs (month, forecast m3, whether a plan is
      // saved), reusing the same activePlansByMonth lookup above rather
      // than a second query.
      const allMonths = forecastMonths.map((row) => ({
        month: row.date,
        forecast_m3: row.predicted_value,
        has_plan: activePlansByMonth.has(row.date),
      }));

      sections.production = {
        next_months: nextMonths,
        all_months: allMonths,
        latest_stock: latestStock,
        days_of_cover: daysOfCover,
      };

      const unplannedMonths = nextMonths
        .filter((m) => !m.plan)
        .map((m) => ({ month: m.month, label: monthLongLabel(m.month) }));
      alerts.push(...overview.productionAlerts({ unplannedMonths, daysOfCover, daysSinceStock }));
    }

    if (permissions.has('distribution:view') && forecast && firstMonthRow) {
      const consumptionResult = await pool.query(
        `SELECT EXTRACT(YEAR FROM year_month)::int AS year,
                EXTRACT(MONTH FROM year_month)::int AS month,
                district,
                SUM(consumption_m3)::double precision AS consumption_m3
         FROM consumption_detail
         GROUP BY year, month, district`
      );
      const consumptionRows = consumptionResult.rows;
      const districts = distribution.listDistricts(consumptionRows);
      const calendarMonth = Number(firstMonthRow.date.slice(5, 7));

      const { rows: districtRows } = distribution.buildDistrictBreakdown({
        consumptionRows,
        districts,
        calendarMonth,
        forecastM3: firstMonthRow.predicted_value,
        lowerM3: firstMonthRow.yhat_lower,
        upperM3: firstMonthRow.yhat_upper,
        planChosenM3: null,
      });

      const largest = districtRows.length
        ? districtRows.reduce((best, r) => (r.forecast_m3 > best.forecast_m3 ? r : best))
        : null;

      sections.distribution = largest
        ? {
            month: firstMonthRow.date,
            district: largest.district,
            share_pct: largest.share_pct,
            forecast_m3: largest.forecast_m3,
          }
        : null;
    }

    if (permissions.has('revenue:view') && forecast && firstMonthRow) {
      const consumptionResult = await pool.query(
        `SELECT EXTRACT(YEAR FROM year_month)::int AS year,
                EXTRACT(MONTH FROM year_month)::int AS month,
                district, subscriber_type,
                SUM(consumption_m3)::double precision AS consumption_m3
         FROM consumption_detail
         GROUP BY year, month, district, subscriber_type`
      );
      const consumptionRows = consumptionResult.rows;
      const cells = revenue.listCells(consumptionRows);

      const latestMonthResult = await pool.query(
        `SELECT TO_CHAR(MAX(year_month), 'YYYY-MM-DD') AS month FROM consumption_detail`
      );
      const subscribersMonth = latestMonthResult.rows[0].month;
      const subscribersByCell = new Map();
      if (subscribersMonth) {
        const subscribersResult = await pool.query(
          `SELECT district, subscriber_type, SUM(subscribers)::int AS subscribers
           FROM consumption_detail
           WHERE year_month = $1::date
           GROUP BY district, subscriber_type`,
          [subscribersMonth]
        );
        subscribersResult.rows.forEach((row) => {
          subscribersByCell.set(revenue.cellKey(row.district, row.subscriber_type), row.subscribers);
        });
      }

      const customerGroupByKey = new Map();
      const customerGroupResult = await pool.query(
        `SELECT district, subscriber_type, (array_agg(customer_group))[1] AS customer_group
         FROM consumption_detail
         GROUP BY district, subscriber_type`
      );
      customerGroupResult.rows.forEach((row) => {
        customerGroupByKey.set(revenue.cellKey(row.district, row.subscriber_type), row.customer_group);
      });

      const tariffTypeMapResult = await pool.query(`SELECT consumption_type, tariff_type FROM tariff_type_map`);
      const consumptionTypeToTariffType = new Map(
        tariffTypeMapResult.rows.map((row) => [row.consumption_type, row.tariff_type])
      );

      const latestTariffDateResult = await pool.query(
        `SELECT TO_CHAR(MAX(valid_from), 'YYYY-MM-DD') AS valid_from FROM tariffs`
      );
      const tariffVersionDate = latestTariffDateResult.rows[0].valid_from;

      let tariffCatalog = new Map();
      if (tariffVersionDate) {
        const tariffRowsResult = await pool.query(
          `SELECT subscriber_type, band_min_m3, band_max_m3, price_per_m3, wastewater_price_per_m3
           FROM tariffs
           WHERE valid_from = $1::date
           ORDER BY subscriber_type, band_min_m3`,
          [tariffVersionDate]
        );
        tariffCatalog = revenue.buildTariffCatalog(tariffRowsResult.rows);
      }

      let firstMonthTotals = null;
      let housingSharePct = null;
      let averagePricePerM3 = null;
      let twelveMonthTotalMid = 0;
      // One entry per forecast month — just enough for the 12-month
      // revenue chart (full detail stays on GET /api/revenue itself).
      const monthlyTotals = [];

      forecastMonths.forEach((row, i) => {
        const calendarMonth = Number(row.date.slice(5, 7));
        const { cells: pricedCells, totals } = revenue.buildRevenueBreakdown({
          consumptionRows,
          cells,
          calendarMonth,
          forecastM3: row.predicted_value,
          lowerM3: row.yhat_lower,
          upperM3: row.yhat_upper,
          subscribersByCell,
          consumptionTypeToTariffType,
          tariffCatalog,
        });

        twelveMonthTotalMid += totals.total.mid;
        monthlyTotals.push({ month: row.date, total_mid: totals.total.mid });

        if (i === 0) {
          firstMonthTotals = totals;
          const byGroup = revenue.buildGroupBreakdown(pricedCells, customerGroupByKey);
          const housing = byGroup.find((g) => g.customer_group === 'Konut');
          housingSharePct = housing && totals.total.mid > 0 ? (housing.total_try / totals.total.mid) * 100 : null;

          const totalVolume = pricedCells.reduce((sum, c) => sum + c.volume_m3, 0);
          const pricedVolume = totalVolume - totals.not_priced_volume_m3;
          averagePricePerM3 = pricedVolume > 0 ? revenue.round2(totals.total.mid / pricedVolume) : null;
        }
      });

      sections.revenue = {
        month: firstMonthRow.date,
        total: firstMonthTotals.total,
        twelve_month_total_mid: revenue.round2(twelveMonthTotalMid),
        housing_share_pct: housingSharePct,
        average_price_per_m3: averagePricePerM3,
        not_priced_pct: firstMonthTotals.not_priced_pct,
        tariff_version_date: tariffVersionDate,
        months: monthlyTotals,
      };

      alerts.push(...overview.revenueAlerts({ notPricedPct: firstMonthTotals.not_priced_pct }));
    }

    if (permissions.has('user:manage')) {
      const activeByRoleResult = await pool.query(
        `SELECT r.display_name AS role_label, COUNT(*)::int AS count
         FROM users u
         JOIN roles r ON r.role_id = u.role_id
         WHERE u.status = 'active'
         GROUP BY r.display_name
         ORDER BY r.display_name`
      );

      const invitedResult = await pool.query(`SELECT name FROM users WHERE status = 'invited' ORDER BY name`);

      const windowDays = overview.OVERVIEW_THRESHOLDS.audit_window_days;
      const signInsResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_log
         WHERE action IN ('login.success', 'emergency.login') AND occurred_at >= now() - ($1 || ' days')::interval`,
        [windowDays]
      );
      const failedResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_log
         WHERE action IN ('login.failure', 'emergency.login_failed') AND occurred_at >= now() - ($1 || ' days')::interval`,
        [windowDays]
      );
      const deniedResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM audit_log
         WHERE action = 'permission.denied' AND occurred_at >= now() - ($1 || ' days')::interval`,
        [windowDays]
      );
      const lastEmergencyResult = await pool.query(
        `SELECT MAX(occurred_at) AS last_at FROM audit_log WHERE action = 'emergency.login'`
      );
      const recentEventsResult = await pool.query(
        `SELECT a.occurred_at, a.action, u.name AS actor_name
         FROM audit_log a
         LEFT JOIN users u ON u.user_id = a.user_id
         ORDER BY a.occurred_at DESC
         LIMIT 5`
      );

      const lastEmergencyAt = lastEmergencyResult.rows[0].last_at;
      const daysSinceEmergencyLogin = lastEmergencyAt
        ? Math.floor((Date.now() - new Date(lastEmergencyAt).getTime()) / 86_400_000)
        : null;

      sections.users = {
        active_by_role: activeByRoleResult.rows,
        invited_never_signed_in: invitedResult.rows.map((row) => row.name),
        sign_ins_last_7_days: signInsResult.rows[0].count,
        failed_attempts_last_7_days: failedResult.rows[0].count,
        permission_denied_last_7_days: deniedResult.rows[0].count,
        last_emergency_login_at: lastEmergencyAt,
        recent_events: recentEventsResult.rows.map((row) => ({
          time: row.occurred_at,
          actor_name: row.actor_name,
          action: row.action,
          label: AUDIT_ACTION_LABELS[row.action] || row.action,
        })),
      };

      alerts.push(
        ...overview.userManageAlerts({
          invitedNeverSignedInNames: invitedResult.rows.map((row) => row.name),
          failedAttempts: failedResult.rows[0].count,
          daysSinceEmergencyLogin,
        })
      );
    }

    res.json({
      first_month: firstMonth,
      data_up_to: dataUpTo,
      published_at: publishedAt,
      thresholds: overview.OVERVIEW_THRESHOLDS,
      alerts,
      sections,
    });
  } catch (err) {
    const reference = generateErrorReference();
    console.error(`[${reference}] /api/overview failed:`, err);
    res.status(500).json({ error: 'Unable to load your overview right now.', reference });
  }
});

// Catch-all for any /api/* path not matched by a route above — a JSON
// 404 instead of Express's default HTML one, since every /api client
// here expects JSON.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Serves the React build and its client-side routes from this same app,
// so the whole site is one Heroku app on one origin. Gated on the build
// actually existing on disk rather than on NODE_ENV: in local dev nobody
// runs `npm run build` for the backend to serve (CRA's own dev server on
// :3000 handles that instead), so frontend/build simply isn't there and
// this stays inactive — exactly today's dev behaviour, no flag needed.
// It's registered last, after every /api route and the JSON 404 above,
// so an unknown /api/* path still gets a JSON 404 instead of falling
// through to index.html.
const FRONTEND_BUILD_DIR = path.join(__dirname, '..', 'frontend', 'build');
if (fs.existsSync(path.join(FRONTEND_BUILD_DIR, 'index.html'))) {
  app.use(express.static(FRONTEND_BUILD_DIR));
  app.get(/^(?!\/api).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_BUILD_DIR, 'index.html'));
  });
}

module.exports = { app, pool };
