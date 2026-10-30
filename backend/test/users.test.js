const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../users');

test('isValidEmail: accepts a plausible address, rejects the obvious non-cases', () => {
  assert.strictEqual(isValidEmail('jane@example.com'), true);
  assert.strictEqual(isValidEmail(' jane@example.com '), true); // trims before checking
  assert.strictEqual(isValidEmail('jane@example'), false);
  assert.strictEqual(isValidEmail('jane.example.com'), false);
  assert.strictEqual(isValidEmail('@example.com'), false);
  assert.strictEqual(isValidEmail(''), false);
  assert.strictEqual(isValidEmail(undefined), false);
});

test('normalizeEmail: trims and lowercases, matching invite_user.py', () => {
  assert.strictEqual(normalizeEmail('  Jane@Example.COM  '), 'jane@example.com');
  assert.strictEqual(normalizeEmail(undefined), '');
  assert.strictEqual(normalizeEmail(null), '');
});

test('validateInviteRequest: all fields valid', () => {
  const result = validateInviteRequest({ name: '  Jane Doe  ', email: ' Jane@Example.com ', role: 'production_manager' });
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.errors, {});
  assert.strictEqual(result.name, 'Jane Doe');
  assert.strictEqual(result.email, 'jane@example.com');
});

test('validateInviteRequest: blank name', () => {
  const result = validateInviteRequest({ name: '   ', email: 'jane@example.com', role: 'admin' });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.errors.name, 'Name is required.');
});

test('validateInviteRequest: missing and malformed email', () => {
  assert.strictEqual(validateInviteRequest({ name: 'Jane', email: '', role: 'admin' }).errors.email, 'Email is required.');
  assert.strictEqual(
    validateInviteRequest({ name: 'Jane', email: 'not-an-email', role: 'admin' }).errors.email,
    'Enter a valid email address.'
  );
});

test('validateInviteRequest: role must be one of the known role names', () => {
  assert.deepStrictEqual(ROLE_NAMES, ['admin', 'production_manager', 'commercial_officer']);
  const result = validateInviteRequest({ name: 'Jane', email: 'jane@example.com', role: 'superadmin' });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.errors.role, 'Choose a valid role.');
});

test('validateInviteRequest: reports every invalid field at once', () => {
  const result = validateInviteRequest({ name: '', email: '', role: '' });
  assert.deepStrictEqual(Object.keys(result.errors).sort(), ['email', 'name', 'role']);
});

test('validateRoleChangeRequest: valid and invalid role names', () => {
  assert.strictEqual(validateRoleChangeRequest({ role: 'admin' }).valid, true);
  const result = validateRoleChangeRequest({ role: 'nope' });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.errors.role, 'Choose a valid role.');
});

test('validateDeactivationReason: enforces both the minimum and maximum length', () => {
  assert.strictEqual(MIN_REASON_LENGTH, 5);
  assert.strictEqual(MAX_REASON_LENGTH, 300);

  const tooShort = validateDeactivationReason('bye');
  assert.strictEqual(tooShort.valid, false);
  assert.match(tooShort.error, /at least 5 characters/);

  const empty = validateDeactivationReason('   ');
  assert.strictEqual(empty.valid, false);

  const tooLong = validateDeactivationReason('x'.repeat(301));
  assert.strictEqual(tooLong.valid, false);
  assert.match(tooLong.error, /at most 300 characters/);

  const justRight = validateDeactivationReason('  Leaving the organisation.  ');
  assert.strictEqual(justRight.valid, true);
  assert.strictEqual(justRight.error, null);
  assert.strictEqual(justRight.trimmed, 'Leaving the organisation.');

  const exactlyMin = validateDeactivationReason('12345');
  assert.strictEqual(exactlyMin.valid, true);
  const exactlyMax = validateDeactivationReason('x'.repeat(300));
  assert.strictEqual(exactlyMax.valid, true);
});

test('validateReactivationReason: optional, but capped when provided', () => {
  assert.deepStrictEqual(validateReactivationReason(undefined), { valid: true, error: null, trimmed: null });
  assert.deepStrictEqual(validateReactivationReason(null), { valid: true, error: null, trimmed: null });
  assert.deepStrictEqual(validateReactivationReason(''), { valid: true, error: null, trimmed: null });

  const provided = validateReactivationReason('  Back from leave.  ');
  assert.strictEqual(provided.valid, true);
  assert.strictEqual(provided.trimmed, 'Back from leave.');

  const tooLong = validateReactivationReason('x'.repeat(301));
  assert.strictEqual(tooLong.valid, false);
  assert.match(tooLong.error, /at most 300 characters/);
});

test('wouldRemoveLastActiveAdmin: only true for an active admin losing the admin role with no other active admin', () => {
  assert.strictEqual(
    wouldRemoveLastActiveAdmin({ currentRole: 'admin', currentStatus: 'active', newRole: 'commercial_officer', otherActiveAdminCount: 0 }),
    true
  );
  // Another active admin exists.
  assert.strictEqual(
    wouldRemoveLastActiveAdmin({ currentRole: 'admin', currentStatus: 'active', newRole: 'commercial_officer', otherActiveAdminCount: 1 }),
    false
  );
  // Staying admin isn't "removing" anything.
  assert.strictEqual(
    wouldRemoveLastActiveAdmin({ currentRole: 'admin', currentStatus: 'active', newRole: 'admin', otherActiveAdminCount: 0 }),
    false
  );
  // Not currently an active admin (e.g. invited admin, or not an admin at all).
  assert.strictEqual(
    wouldRemoveLastActiveAdmin({ currentRole: 'admin', currentStatus: 'invited', newRole: 'commercial_officer', otherActiveAdminCount: 0 }),
    false
  );
  assert.strictEqual(
    wouldRemoveLastActiveAdmin({ currentRole: 'commercial_officer', currentStatus: 'active', newRole: 'production_manager', otherActiveAdminCount: 0 }),
    false
  );
});

test('wouldDeactivateLastActiveAdmin: only true for the last active admin', () => {
  assert.strictEqual(
    wouldDeactivateLastActiveAdmin({ currentRole: 'admin', currentStatus: 'active', otherActiveAdminCount: 0 }),
    true
  );
  assert.strictEqual(
    wouldDeactivateLastActiveAdmin({ currentRole: 'admin', currentStatus: 'active', otherActiveAdminCount: 2 }),
    false
  );
  assert.strictEqual(
    wouldDeactivateLastActiveAdmin({ currentRole: 'admin', currentStatus: 'invited', otherActiveAdminCount: 0 }),
    false
  );
  assert.strictEqual(
    wouldDeactivateLastActiveAdmin({ currentRole: 'production_manager', currentStatus: 'active', otherActiveAdminCount: 0 }),
    false
  );
});
