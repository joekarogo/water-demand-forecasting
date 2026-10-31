const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ADMIN_IDLE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  ABSOLUTE_SESSION_LIMIT_MS,
  MAX_FAILED_LOGIN_ATTEMPTS,
  STEP_UP_WINDOW_MS,
  getIdleTimeoutMs,
  computeSessionExpiry,
  getSessionCookieOptions,
  generateSessionId,
  hashSessionId,
  generateCsrfToken,
  csrfTokensMatch,
  isBlockedByFailedAttempts,
  isWithinStepUpWindow,
} = require('../auth');

test('getIdleTimeoutMs: 30 minutes for admin, 60 for every other role', () => {
  assert.strictEqual(getIdleTimeoutMs('admin'), ADMIN_IDLE_TIMEOUT_MS);
  assert.strictEqual(ADMIN_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
  assert.strictEqual(getIdleTimeoutMs('production_manager'), DEFAULT_IDLE_TIMEOUT_MS);
  assert.strictEqual(getIdleTimeoutMs('manager'), DEFAULT_IDLE_TIMEOUT_MS);
  assert.strictEqual(getIdleTimeoutMs('commercial_officer'), DEFAULT_IDLE_TIMEOUT_MS);
  assert.strictEqual(getIdleTimeoutMs(undefined), DEFAULT_IDLE_TIMEOUT_MS);
  assert.strictEqual(DEFAULT_IDLE_TIMEOUT_MS, 60 * 60 * 1000);
});

test('computeSessionExpiry: picks the idle timeout when it is well inside the absolute limit', () => {
  const createdAt = new Date('2026-01-01T09:00:00Z');
  const now = new Date('2026-01-01T09:05:00Z'); // 5 minutes into the session
  const expiry = computeSessionExpiry({ now, createdAt, roleName: 'production_manager' });
  assert.strictEqual(expiry.getTime(), now.getTime() + DEFAULT_IDLE_TIMEOUT_MS);
});

test('computeSessionExpiry: caps at the 8-hour absolute limit near the end of a long session', () => {
  const createdAt = new Date('2026-01-01T09:00:00Z');
  // 7 hours 50 minutes in: idle timeout alone would push past 8 hours.
  const now = new Date(createdAt.getTime() + 7 * 60 * 60 * 1000 + 50 * 60 * 1000);
  const expiry = computeSessionExpiry({ now, createdAt, roleName: 'production_manager' });
  assert.strictEqual(expiry.getTime(), createdAt.getTime() + ABSOLUTE_SESSION_LIMIT_MS);
});

test('computeSessionExpiry: admin idle timeout is also capped by the same absolute limit', () => {
  const createdAt = new Date('2026-01-01T09:00:00Z');
  const now = new Date(createdAt.getTime() + 7 * 60 * 60 * 1000 + 50 * 60 * 1000);
  const expiry = computeSessionExpiry({ now, createdAt, roleName: 'admin' });
  assert.strictEqual(expiry.getTime(), createdAt.getTime() + ABSOLUTE_SESSION_LIMIT_MS);
});

test('getSessionCookieOptions: secure only in production, other flags always on', () => {
  const dev = getSessionCookieOptions({ production: false, maxAgeMs: 1000 });
  assert.strictEqual(dev.secure, false);
  assert.strictEqual(dev.httpOnly, true);
  assert.strictEqual(dev.sameSite, 'strict');
  assert.strictEqual(dev.path, '/');
  assert.strictEqual(dev.maxAge, 1000);

  const prod = getSessionCookieOptions({ production: true, maxAgeMs: 2000 });
  assert.strictEqual(prod.secure, true);
  assert.strictEqual(prod.maxAge, 2000);
});

test('generateSessionId / generateCsrfToken: 64-character hex, unique per call', () => {
  const idA = generateSessionId();
  const idB = generateSessionId();
  assert.match(idA, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(idA, idB);

  const csrfA = generateCsrfToken();
  const csrfB = generateCsrfToken();
  assert.match(csrfA, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(csrfA, csrfB);
});

test('hashSessionId: deterministic, 64-character hex, never equal to its input', () => {
  assert.strictEqual(hashSessionId('abc'), hashSessionId('abc'));
  assert.notStrictEqual(hashSessionId('abc'), hashSessionId('abd'));
  assert.match(hashSessionId('abc'), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(hashSessionId('abc'), 'abc');
});

test('csrfTokensMatch: equal tokens match, everything else does not', () => {
  const token = generateCsrfToken();
  assert.strictEqual(csrfTokensMatch(token, token), true);
  assert.strictEqual(csrfTokensMatch(token, generateCsrfToken()), false);
  assert.strictEqual(csrfTokensMatch(token, token.slice(0, -1)), false); // different length
  assert.strictEqual(csrfTokensMatch(token, undefined), false);
  assert.strictEqual(csrfTokensMatch(undefined, token), false);
  assert.strictEqual(csrfTokensMatch('', ''), false); // empty expected is never a valid match
});

test('isBlockedByFailedAttempts: blocks at and above the threshold, not below it', () => {
  assert.strictEqual(MAX_FAILED_LOGIN_ATTEMPTS, 5);
  assert.strictEqual(isBlockedByFailedAttempts(0), false);
  assert.strictEqual(isBlockedByFailedAttempts(4), false);
  assert.strictEqual(isBlockedByFailedAttempts(5), true);
  assert.strictEqual(isBlockedByFailedAttempts(6), true);
});

test('isWithinStepUpWindow: true up to and including 10 minutes old, false just past it', () => {
  assert.strictEqual(STEP_UP_WINDOW_MS, 10 * 60 * 1000);
  const sessionCreatedAt = new Date('2026-01-01T09:00:00Z');

  assert.strictEqual(
    isWithinStepUpWindow({ now: sessionCreatedAt, sessionCreatedAt }),
    true
  ); // 0 minutes old
  assert.strictEqual(
    isWithinStepUpWindow({ now: new Date(sessionCreatedAt.getTime() + 9 * 60 * 1000), sessionCreatedAt }),
    true
  ); // 9 minutes old
  assert.strictEqual(
    isWithinStepUpWindow({ now: new Date(sessionCreatedAt.getTime() + STEP_UP_WINDOW_MS), sessionCreatedAt }),
    true
  ); // exactly 10 minutes old — inclusive
  assert.strictEqual(
    isWithinStepUpWindow({ now: new Date(sessionCreatedAt.getTime() + STEP_UP_WINDOW_MS + 1), sessionCreatedAt }),
    false
  ); // 10 minutes and 1ms old
  assert.strictEqual(
    isWithinStepUpWindow({ now: new Date(sessionCreatedAt.getTime() + 60 * 60 * 1000), sessionCreatedAt }),
    false
  ); // 1 hour old
});
