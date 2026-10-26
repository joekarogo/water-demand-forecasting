// Pure, testable helpers for Module 1 Part 2A (Google sign-in + server-side
// sessions). No database access here — see backend/index.js for the
// routes/middleware that use these against the `sessions` and
// `login_attempts` tables.

const crypto = require('crypto');

const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes
const ABSOLUTE_SESSION_LIMIT_MS = 8 * 60 * 60 * 1000; // 8 hours from session creation

// The emergency-login lockout is a plain rolling window, not a separate
// stored "blocked until" timestamp: once enough of the failing attempts
// age out of this window, the count drops back below the threshold on its
// own, with no extra bookkeeping needed.
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const FAILED_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Admin sessions idle out sooner than everyone else's — by *role name*
// (the users.role / roles.name value), not by any per-user setting.
function getIdleTimeoutMs(roleName) {
  return roleName === 'admin' ? ADMIN_IDLE_TIMEOUT_MS : DEFAULT_IDLE_TIMEOUT_MS;
}

// Sliding expiry: every valid request pushes expires_at forward by the
// idle timeout, but never past createdAt + the 8-hour absolute limit.
function computeSessionExpiry({ now, createdAt, roleName }) {
  const idleExpiryMs = now.getTime() + getIdleTimeoutMs(roleName);
  const absoluteExpiryMs = createdAt.getTime() + ABSOLUTE_SESSION_LIMIT_MS;
  return new Date(Math.min(idleExpiryMs, absoluteExpiryMs));
}

// Options for the `sid` cookie. `secure` is only true in production — a
// non-HTTPS local dev server can't set a Secure cookie and have the
// browser send it back.
function getSessionCookieOptions({ production, maxAgeMs }) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: !!production,
    maxAge: maxAgeMs,
  };
}

// The raw session id sent to the browser as the cookie value — 32 random
// bytes, hex-encoded (64 characters). Never stored as-is; see
// hashSessionId below.
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

// What actually goes in sessions.session_id_hash. Deterministic, so a
// lookup just hashes the incoming cookie value and matches it — the raw
// id itself never touches the database.
function hashSessionId(rawSessionId) {
  return crypto.createHash('sha256').update(rawSessionId).digest('hex');
}

// Per-session CSRF token — 32 random bytes, hex-encoded (64 characters),
// matching the `csrf_token CHAR(64)` column.
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Constant-time comparison (crypto.timingSafeEqual) so a wrong CSRF token
// can't be guessed faster by timing how long the comparison takes.
// timingSafeEqual itself throws on a length mismatch, so that's checked
// first — this leaks only the *length* of a mismatch, not any byte value,
// and the expected length (64 hex chars) is already public knowledge.
function csrfTokensMatch(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string' || expected.length === 0) {
    return false;
  }
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

// The emergency-login lockout rule: 5 or more failed attempts from the
// same IP in the last 15 minutes. The caller is responsible for counting
// `login_attempts` rows in that window; this just applies the threshold.
function isBlockedByFailedAttempts(recentFailedCount) {
  return recentFailedCount >= MAX_FAILED_LOGIN_ATTEMPTS;
}

module.exports = {
  ADMIN_IDLE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  ABSOLUTE_SESSION_LIMIT_MS,
  MAX_FAILED_LOGIN_ATTEMPTS,
  FAILED_LOGIN_WINDOW_MS,
  getIdleTimeoutMs,
  computeSessionExpiry,
  getSessionCookieOptions,
  generateSessionId,
  hashSessionId,
  generateCsrfToken,
  csrfTokensMatch,
  isBlockedByFailedAttempts,
};
