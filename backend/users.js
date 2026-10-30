// Pure functions for Module 1 Part 4 (the Users page) — no database
// access, so these can be unit-tested directly (see test/users.test.js).
// Mirrors database/invite_user.py's own validation rules where relevant.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_NAMES = ['admin', 'production_manager', 'commercial_officer'];
const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 300;

function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

// Trimmed + lowercased — the same normalization invite_user.py and the
// Google/emergency login routes already use when matching an email.
function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// Field-level errors for POST /api/users (invite). Returns the
// normalized name/email alongside `valid`/`errors` so the caller never
// has to re-derive them.
function validateInviteRequest({ name, email, role }) {
  const errors = {};

  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) {
    errors.name = 'Name is required.';
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    errors.email = 'Email is required.';
  } else if (!isValidEmail(normalizedEmail)) {
    errors.email = 'Enter a valid email address.';
  }

  if (!ROLE_NAMES.includes(role)) {
    errors.role = 'Choose a valid role.';
  }

  return { valid: Object.keys(errors).length === 0, errors, name: trimmedName, email: normalizedEmail };
}

function validateRoleChangeRequest({ role }) {
  const errors = {};
  if (!ROLE_NAMES.includes(role)) {
    errors.role = 'Choose a valid role.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

// Required, 5-300 characters after trimming — shown back on the user's
// row and recorded in the audit log.
function validateDeactivationReason(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < MIN_REASON_LENGTH) {
    return { valid: false, error: `Enter a reason (at least ${MIN_REASON_LENGTH} characters).`, trimmed };
  }
  if (trimmed.length > MAX_REASON_LENGTH) {
    return { valid: false, error: `The reason can be at most ${MAX_REASON_LENGTH} characters.`, trimmed };
  }
  return { valid: true, error: null, trimmed };
}

// Optional context for a reactivation's audit entry — unlike a
// deactivation reason, this one isn't required; only its max length is
// enforced when something is actually provided.
function validateReactivationReason(value) {
  if (value === undefined || value === null || value === '') {
    return { valid: true, error: null, trimmed: null };
  }
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length > MAX_REASON_LENGTH) {
    return { valid: false, error: `The reason can be at most ${MAX_REASON_LENGTH} characters.`, trimmed };
  }
  return { valid: true, error: null, trimmed: trimmed || null };
}

// Whether changing `currentRole` -> `newRole` would leave the system
// with no active Admin. The caller supplies how many OTHER active admins
// exist (i.e. not counting the user being changed), so this stays pure
// and testable without a database.
function wouldRemoveLastActiveAdmin({ currentRole, currentStatus, newRole, otherActiveAdminCount }) {
  return currentRole === 'admin' && currentStatus === 'active' && newRole !== 'admin' && otherActiveAdminCount < 1;
}

// Same idea, for deactivating an account instead of changing its role.
function wouldDeactivateLastActiveAdmin({ currentRole, currentStatus, otherActiveAdminCount }) {
  return currentRole === 'admin' && currentStatus === 'active' && otherActiveAdminCount < 1;
}

module.exports = {
  ROLE_NAMES,
  MIN_REASON_LENGTH,
  MAX_REASON_LENGTH,
  isValidEmail,
  normalizeEmail,
  validateInviteRequest,
  validateRoleChangeRequest,
  validateDeactivationReason,
  validateReactivationReason,
  wouldRemoveLastActiveAdmin,
  wouldDeactivateLastActiveAdmin,
};
