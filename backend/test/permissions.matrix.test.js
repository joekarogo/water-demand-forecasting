// Module 1, Part 4: a permission matrix for every protected route,
// exercised against a REAL (throwaway) database and a REAL copy of this
// app (backend/app.js) listening on a random port — not mocked, so a
// mistake in a route's middleware chain is actually caught.
//
// Skipped entirely unless TEST_DATABASE_URL is set, and refuses to run if
// that URL points at the same database as the main app's DB_HOST/DB_NAME/
// DB_PORT, or at a database whose name doesn't end in "_test" — see
// docs/testing_permissions.md for how to set it up. Once those checks
// pass, every run wipes the test database itself (DROP SCHEMA public
// CASCADE) before applying migrations, so there's nothing to reset by
// hand between runs.
//
// Expectations below come from the role -> permission grants in
// database/schema/001_foundation.sql, 003_production_planning.sql and
// 004_accounts.sql (ROLE_PERMISSIONS), not from re-deriving them here.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  test(
    'permission matrix (skipped — set TEST_DATABASE_URL to run; see docs/testing_permissions.md)',
    { skip: true },
    () => {}
  );
  return;
}

// --- Safety: never let this run against the main database. -----------------
function parseConnectionTarget(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: parsed.pathname.replace(/^\//, ''),
  };
}

const testTarget = parseConnectionTarget(TEST_DATABASE_URL);
const mainTarget = {
  host: process.env.DB_HOST || '',
  port: String(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || '',
};
const pointsAtMainDatabase =
  testTarget.host === mainTarget.host &&
  String(testTarget.port) === mainTarget.port &&
  testTarget.database === mainTarget.database &&
  testTarget.database !== '';

if (pointsAtMainDatabase) {
  test('refuses to run against the main database', () => {
    assert.fail(
      `TEST_DATABASE_URL (${testTarget.host}:${testTarget.port}/${testTarget.database}) is the same database as ` +
        'DB_HOST/DB_NAME/DB_PORT in .env. Use a separate, disposable database — see docs/testing_permissions.md.'
    );
  });
  return;
}

// This test resets its database (DROP SCHEMA public CASCADE) at the
// start of every run, so it only ever runs against something unmistakably
// disposable — a database name ending in anything else is refused.
if (!testTarget.database.endsWith('_test')) {
  test('refuses to run against a database not named *_test', () => {
    assert.fail(
      `TEST_DATABASE_URL's database ("${testTarget.database}") doesn't end in "_test". Refusing to run — ` +
        'this test drops and recreates the public schema on every run, so it only ever runs against a ' +
        'database clearly marked as disposable. See docs/testing_permissions.md.'
    );
  });
  return;
}

// Everything below only runs once we know it's safe.
const auth = require('../auth');

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'database', 'schema');
const MIGRATIONS = [
  '000_existing_schema.sql',
  '001_foundation.sql',
  '002_published_forecast.sql',
  '003_production_planning.sql',
  '004_accounts.sql',
  '005_sessions.sql',
  '006_remove_password_login.sql',
  '007_role_names_job_title.sql',
];

// The role -> permission table as of migrations 001, 003 and 004 (003
// removes admin's plan:view; 004 removes admin's distribution:view/
// tariff:view/revenue:view and adds data:view).
const ROLE_PERMISSIONS = {
  admin: new Set(['forecast:view', 'user:manage', 'settings:edit', 'audit:view_all', 'report:view', 'report:export', 'data:view']),
  production_manager: new Set([
    'forecast:view',
    'plan:view',
    'plan:create',
    'stock:create',
    'distribution:view',
    'audit:view_own',
    'report:view',
    'report:export',
  ]),
  commercial_officer: new Set([
    'forecast:view',
    'tariff:view',
    'tariff:edit',
    'revenue:view',
    'audit:view_own',
    'report:view',
    'report:export',
  ]),
};
const ACTIVE_ROLES = ['admin', 'production_manager', 'commercial_officer'];

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Wipes everything in the test database so every run starts from a clean
// slate — no need to drop/recreate the database itself between runs.
// Safe only because the safety checks above already refused to run
// against anything but a dedicated *_test database.
async function resetSchema(client) {
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

async function applyMigrations(client) {
  for (const filename of MIGRATIONS) {
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, filename), 'utf8');
    await client.query(sql);
  }
}

async function getRoleId(client, roleName) {
  const result = await client.query('SELECT role_id FROM roles WHERE name = $1', [roleName]);
  return result.rows[0].role_id;
}

let userCounter = 0;
async function createUser(client, { roleName, status, authProvider = 'google', googleSub, deactivationReason = null }) {
  userCounter += 1;
  const roleId = await getRoleId(client, roleName);
  const email = `matrix-${roleName}-${status}-${userCounter}@test.local`;
  const sub = googleSub === undefined ? (authProvider === 'google' ? `matrix-sub-${userCounter}` : null) : googleSub;
  const result = await client.query(
    `INSERT INTO users (name, email, password, role_id, status, auth_provider, google_sub, deactivation_reason, deactivated_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, CASE WHEN $4::varchar = 'deactivated' THEN now() ELSE NULL END)
     RETURNING user_id`,
    [`Matrix ${roleName} ${status} ${userCounter}`, email, roleId, status, authProvider, sub, deactivationReason]
  );
  return result.rows[0].user_id;
}

async function createSessionDirect(client, userId) {
  const rawSessionId = auth.generateSessionId();
  const sessionIdHash = auth.hashSessionId(rawSessionId);
  const csrfToken = auth.generateCsrfToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000);
  await client.query(
    `INSERT INTO sessions (session_id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at)
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [sessionIdHash, userId, csrfToken, now, expiresAt]
  );
  return { rawSessionId, csrfToken };
}

async function seedForecast(client) {
  const forecastResult = await client.query(
    `INSERT INTO forecasts (generated_at, forecast_period, mae, rmse, horizon, model_name, mape, kind, data_up_to, train_start, train_end, interval_width)
     VALUES (now(), '1m', 1000, 1500, 1, 'prophet', 5.2, 'published', '2026-09-01', '2016-01-01', '2026-09-01', 0.80)
     RETURNING forecast_id`
  );
  const forecastId = forecastResult.rows[0].forecast_id;
  const month = '2026-10-01';
  await client.query(
    `INSERT INTO forecast_results (forecast_id, date, predicted_value, yhat_lower, yhat_upper)
     VALUES ($1, $2, 25000000, 23000000, 27000000)`,
    [forecastId, month]
  );
  return { forecastId, month };
}

function cookieHeader(rawSessionId) {
  return `sid=${rawSessionId}`;
}

async function request(baseUrl, { method, path: routePath, cookie, csrfToken, body }) {
  const headers = {};
  if (cookie) headers['Cookie'] = cookieHeader(cookie);
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('permission matrix', async (t) => {
  // app.js's own Pool is constructed at require-time, reading
  // DATABASE_URL in preference to DB_HOST/DB_NAME/etc — setting it here,
  // before requiring app.js below, is what points the real app at this
  // throwaway database instead of the main one.
  process.env.DATABASE_URL = TEST_DATABASE_URL;

  const setupPool = new Pool({ connectionString: TEST_DATABASE_URL });
  const setupClient = await setupPool.connect();

  let server;
  let appPool;
  let baseUrl;
  const fixtures = {};

  try {
    await resetSchema(setupClient);
    await applyMigrations(setupClient);

    const { forecastId, month } = await seedForecast(setupClient);
    fixtures.forecastId = forecastId;
    fixtures.month = month;

    for (const roleName of ACTIVE_ROLES) {
      const userId = await createUser(setupClient, { roleName, status: 'active' });
      const { rawSessionId, csrfToken } = await createSessionDirect(setupClient, userId);
      // A second, dedicated session per role for the one test that
      // actually consumes it (logout deletes the session it's called
      // with) — every other assertion keeps reusing the primary one above.
      const { rawSessionId: logoutCookie, csrfToken: logoutCsrfToken } = await createSessionDirect(setupClient, userId);
      fixtures[roleName] = { userId, cookie: rawSessionId, csrfToken, logoutCookie, logoutCsrfToken };
    }

    const deactivatedUserId = await createUser(setupClient, {
      roleName: 'production_manager',
      status: 'deactivated',
      deactivationReason: 'Pre-seeded deactivated fixture for the permission matrix.',
    });
    const { rawSessionId: deactivatedCookie } = await createSessionDirect(setupClient, deactivatedUserId);
    fixtures.deactivated = { userId: deactivatedUserId, cookie: deactivatedCookie };

    fixtures.roleChangeTargetId = await createUser(setupClient, { roleName: 'commercial_officer', status: 'active' });
    fixtures.deactivateTargetId = await createUser(setupClient, { roleName: 'commercial_officer', status: 'active' });
    fixtures.reactivateTargetId = await createUser(setupClient, {
      roleName: 'commercial_officer',
      status: 'deactivated',
      deactivationReason: 'Pre-seeded for the reactivate test.',
    });
    fixtures.jobTitleTargetId = await createUser(setupClient, { roleName: 'commercial_officer', status: 'active' });

    // Two distinct sign-in audit rows, on two different users, so the
    // "own rows only" check below can tell them apart.
    await setupClient.query(
      `INSERT INTO audit_log (user_id, action, ip_address) VALUES ($1, 'login.success', $2)`,
      [fixtures.admin.userId, '203.0.113.10']
    );
    await setupClient.query(
      `INSERT INTO audit_log (user_id, action, ip_address) VALUES ($1, 'emergency.login', $2)`,
      [fixtures.production_manager.userId, '203.0.113.20']
    );

    const appModule = require('../app');
    appPool = appModule.pool;
    server = appModule.app.listen(0);
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;

    let inviteCounter = 0;
    const ROUTES = [
      { name: 'GET /api/forecast/published', method: 'GET', path: '/api/forecast/published', permission: 'forecast:view' },
      { name: 'GET /api/consumption-history', method: 'GET', path: '/api/consumption-history', permission: 'data:view' },
      { name: 'GET /api/production/plan', method: 'GET', path: '/api/production/plan', permission: 'plan:view' },
      {
        name: 'GET /api/production/plan/:month/history',
        method: 'GET',
        path: `/api/production/plan/${fixtures.month}/history`,
        permission: 'plan:view',
      },
      {
        name: 'POST /api/production/plan',
        method: 'POST',
        path: '/api/production/plan',
        permission: 'plan:create',
        csrf: true,
        body: () => ({ forecast_id: fixtures.forecastId, month: fixtures.month, plan_type: 'normal', expected_version: 0 }),
      },
      { name: 'GET /api/production/stock', method: 'GET', path: '/api/production/stock', permission: 'plan:view' },
      {
        name: 'POST /api/production/stock',
        method: 'POST',
        path: '/api/production/stock',
        permission: 'stock:create',
        csrf: true,
        body: () => ({ recorded_on: todayDateString(), stock_m3: 1000 }),
      },
      { name: 'GET /api/roles', method: 'GET', path: '/api/roles', permission: 'user:manage' },
      { name: 'GET /api/users', method: 'GET', path: '/api/users', permission: 'user:manage' },
      {
        name: 'POST /api/users',
        method: 'POST',
        path: '/api/users',
        permission: 'user:manage',
        csrf: true,
        successStatus: 201,
        body: () => {
          inviteCounter += 1;
          return { name: 'Matrix Invitee', email: `matrix-invitee-${inviteCounter}@test.local`, role: 'commercial_officer' };
        },
      },
      {
        name: 'PATCH /api/users/:id/role',
        method: 'PATCH',
        path: `/api/users/${fixtures.roleChangeTargetId}/role`,
        permission: 'user:manage',
        csrf: true,
        body: () => ({ role: 'production_manager' }),
      },
      {
        name: 'POST /api/users/:id/deactivate',
        method: 'POST',
        path: `/api/users/${fixtures.deactivateTargetId}/deactivate`,
        permission: 'user:manage',
        csrf: true,
        body: () => ({ reason: 'Matrix test deactivation.' }),
      },
      {
        name: 'POST /api/users/:id/reactivate',
        method: 'POST',
        path: `/api/users/${fixtures.reactivateTargetId}/reactivate`,
        permission: 'user:manage',
        csrf: true,
        body: () => ({}),
      },
      {
        name: 'PATCH /api/users/:id/job-title',
        method: 'PATCH',
        path: `/api/users/${fixtures.jobTitleTargetId}/job-title`,
        permission: 'user:manage',
        csrf: true,
        body: () => ({ job_title: 'Matrix Job Title' }),
      },
      { name: 'GET /api/me', method: 'GET', path: '/api/me', permission: null },
      { name: 'GET /api/me/sign-ins', method: 'GET', path: '/api/me/sign-ins', permission: null },
      { name: 'GET /api/about', method: 'GET', path: '/api/about', permission: null },
    ];

    for (const route of ROUTES) {
      await t.test(route.name, async (t2) => {
        await t2.test('no cookie -> 401', async () => {
          const res = await request(baseUrl, { method: route.method, path: route.path });
          assert.strictEqual(res.status, 401);
        });

        await t2.test('deactivated user -> 401', async () => {
          const res = await request(baseUrl, {
            method: route.method,
            path: route.path,
            cookie: fixtures.deactivated.cookie,
            csrfToken: fixtures.deactivated.csrfToken,
            body: route.body ? route.body() : undefined,
          });
          assert.strictEqual(res.status, 401);
        });

        for (const roleName of ACTIVE_ROLES) {
          await t2.test(`${roleName} -> expected status`, async () => {
            const allowed = !route.permission || ROLE_PERMISSIONS[roleName].has(route.permission);
            const expected = allowed ? route.successStatus ?? 200 : 403;
            const res = await request(baseUrl, {
              method: route.method,
              path: route.path,
              cookie: fixtures[roleName].cookie,
              csrfToken: route.csrf ? fixtures[roleName].csrfToken : undefined,
              body: route.body ? route.body() : undefined,
            });
            assert.strictEqual(res.status, expected);
          });
        }

        if (route.csrf) {
          await t2.test('missing CSRF header on POST/PATCH -> 403', async () => {
            const allowedRole = route.permission
              ? ACTIVE_ROLES.find((r) => ROLE_PERMISSIONS[r].has(route.permission))
              : ACTIVE_ROLES[0];
            const res = await request(baseUrl, {
              method: route.method,
              path: route.path,
              cookie: fixtures[allowedRole].cookie,
              body: route.body ? route.body() : undefined,
            });
            assert.strictEqual(res.status, 403);
          });
        }
      });
    }

    await t.test('GET /api/me/sign-ins returns only the caller\'s own rows', async () => {
      const res = await request(baseUrl, { method: 'GET', path: '/api/me/sign-ins', cookie: fixtures.admin.cookie });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.sign_ins));
      assert.ok(body.sign_ins.every((row) => row.ip_address !== '203.0.113.20'));
      assert.ok(body.sign_ins.some((row) => row.ip_address === '203.0.113.10' && row.method === 'Google'));

      const res2 = await request(baseUrl, {
        method: 'GET',
        path: '/api/me/sign-ins',
        cookie: fixtures.production_manager.cookie,
      });
      const body2 = await res2.json();
      assert.ok(body2.sign_ins.every((row) => row.ip_address !== '203.0.113.10'));
      assert.ok(body2.sign_ins.some((row) => row.ip_address === '203.0.113.20' && row.method === 'Emergency'));
    });

    await t.test('X-Session-Expires-In / X-Session-Max-Reached response headers', async () => {
      const res = await request(baseUrl, { method: 'GET', path: '/api/me', cookie: fixtures.admin.cookie });
      const expiresIn = res.headers.get('x-session-expires-in');
      assert.ok(expiresIn !== null, 'X-Session-Expires-In header should be set');
      assert.ok(Number.isInteger(Number(expiresIn)) && Number(expiresIn) > 0);
      assert.strictEqual(res.headers.get('x-session-max-reached'), 'false');
    });

    await t.test('unmatched /api route returns a JSON 404', async () => {
      const res = await request(baseUrl, { method: 'GET', path: '/api/this-route-does-not-exist' });
      assert.strictEqual(res.status, 404);
      const body = await res.json();
      assert.ok(body.error);
    });

    await t.test('POST /api/auth/logout', async (t2) => {
      await t2.test('no cookie -> 401', async () => {
        const res = await request(baseUrl, { method: 'POST', path: '/api/auth/logout' });
        assert.strictEqual(res.status, 401);
      });

      await t2.test('deactivated user -> 401', async () => {
        const res = await request(baseUrl, {
          method: 'POST',
          path: '/api/auth/logout',
          cookie: fixtures.deactivated.cookie,
          csrfToken: fixtures.deactivated.csrfToken,
        });
        assert.strictEqual(res.status, 401);
      });

      await t2.test('missing CSRF header -> 403', async () => {
        const res = await request(baseUrl, {
          method: 'POST',
          path: '/api/auth/logout',
          cookie: fixtures.admin.cookie,
        });
        assert.strictEqual(res.status, 403);
      });

      for (const roleName of ACTIVE_ROLES) {
        await t2.test(`${roleName} -> 204 (dedicated session)`, async () => {
          const res = await request(baseUrl, {
            method: 'POST',
            path: '/api/auth/logout',
            cookie: fixtures[roleName].logoutCookie,
            csrfToken: fixtures[roleName].logoutCsrfToken,
          });
          assert.strictEqual(res.status, 204);
        });
      }
    });
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (appPool) {
      await appPool.end();
    }
    setupClient.release();
    await setupPool.end();
  }
});
