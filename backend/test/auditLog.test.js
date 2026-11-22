const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ACTION_LABELS,
  CATEGORY_ACTIONS,
  CATEGORIES,
  FAILED_SIGN_IN_ACTIONS,
  MAX_PAGE_SIZE,
  getCategoryForAction,
  getActor,
  validateActivityLogFilters,
  summarizeDetails,
  escapeCsvField,
  buildCsv,
} = require('../auditLog');

// Every action string actually written to audit_log anywhere in this
// codebase — found by grepping every `INSERT INTO audit_log` and
// `insertAuditLog(...)` call site in backend/app.js, database/*.py,
// database/schema/*.sql and ml/*.py. If a new call site is ever added
// with a string that isn't listed here, add it here too — this list is
// the completeness check's source of truth, not ACTION_LABELS's own keys.
const KNOWN_ACTIONS = [
  'login.success',
  'login.failure',
  'emergency.login',
  'emergency.login_failed',
  'logout',
  'permission.denied',
  'user.invited',
  'user.role_changed',
  'user.deactivated',
  'user.reactivated',
  'user.job_title_changed',
  'plan.save',
  'stock.record',
  'stock.correct',
  'stock.remove',
  'audit.exported',
  'emergency_admin.set', // database/create_emergency_admin.py
  'forecast_published', // ml/publish_forecast.py
];

test('category mapping: every category maps to a non-empty set of real action names', () => {
  CATEGORIES.forEach((category) => {
    const actions = CATEGORY_ACTIONS[category];
    assert.ok(Array.isArray(actions) && actions.length > 0, `${category} should map to at least one action`);
    actions.forEach((action) => {
      assert.ok(action in ACTION_LABELS, `${category}'s action "${action}" should have a known label`);
    });
  });
});

test('category mapping: no action belongs to more than one category', () => {
  const seen = new Map();
  CATEGORIES.forEach((category) => {
    CATEGORY_ACTIONS[category].forEach((action) => {
      assert.ok(!seen.has(action), `"${action}" is in both "${seen.get(action)}" and "${category}"`);
      seen.set(action, category);
    });
  });
});

test('getCategoryForAction: maps every categorized action back to its category', () => {
  CATEGORIES.forEach((category) => {
    CATEGORY_ACTIONS[category].forEach((action) => {
      assert.strictEqual(getCategoryForAction(action), category);
    });
  });
});

test('getCategoryForAction: every action in ACTION_LABELS has a category (nothing is left uncategorized)', () => {
  Object.keys(ACTION_LABELS).forEach((action) => {
    assert.ok(getCategoryForAction(action) !== null, `"${action}" has a label but no category`);
  });
});

test('getCategoryForAction: logout is in the sign-ins-and-sign-outs category (not uncategorized)', () => {
  assert.strictEqual(getCategoryForAction('logout'), 'sign_in');
});

test('getCategoryForAction: a genuinely unknown action returns null', () => {
  assert.strictEqual(getCategoryForAction('made.up.action'), null);
});

test('every action actually written anywhere in this codebase (KNOWN_ACTIONS) has a label', () => {
  KNOWN_ACTIONS.forEach((action) => {
    assert.ok(action in ACTION_LABELS, `"${action}" is written to audit_log somewhere but has no ACTION_LABELS entry`);
  });
});

test('every action actually written anywhere in this codebase (KNOWN_ACTIONS) has a category', () => {
  KNOWN_ACTIONS.forEach((action) => {
    assert.ok(getCategoryForAction(action) !== null, `"${action}" is written to audit_log somewhere but has no category`);
  });
});

test('validateActivityLogFilters: no filters at all is valid, with defaults applied', () => {
  const { valid, errors, filters } = validateActivityLogFilters({}, { canFilterByUser: true });
  assert.strictEqual(valid, true);
  assert.deepStrictEqual(errors, {});
  assert.strictEqual(filters.page, 1);
  assert.strictEqual(filters.pageSize, 50);
});

test('validateActivityLogFilters: a well-formed from/to/category/q/page/page_size all pass through', () => {
  const { valid, filters } = validateActivityLogFilters(
    { from: '2026-01-01', to: '2026-01-31', category: 'failed_sign_in', q: '  bad login  ', page: '2', page_size: '25' },
    { canFilterByUser: true }
  );
  assert.strictEqual(valid, true);
  assert.strictEqual(filters.from, '2026-01-01');
  assert.strictEqual(filters.to, '2026-01-31');
  assert.strictEqual(filters.category, 'failed_sign_in');
  assert.strictEqual(filters.q, 'bad login');
  assert.strictEqual(filters.page, 2);
  assert.strictEqual(filters.pageSize, 25);
});

test('validateActivityLogFilters: a malformed date is a 400-shaped field error', () => {
  const { valid, errors } = validateActivityLogFilters({ from: 'not-a-date' }, { canFilterByUser: true });
  assert.strictEqual(valid, false);
  assert.ok(errors.from);
});

test('validateActivityLogFilters: an impossible calendar date (Feb 30) is rejected', () => {
  const { valid, errors } = validateActivityLogFilters({ to: '2026-02-30' }, { canFilterByUser: true });
  assert.strictEqual(valid, false);
  assert.ok(errors.to);
});

test('validateActivityLogFilters: "to" before "from" is rejected', () => {
  const { valid, errors } = validateActivityLogFilters(
    { from: '2026-02-01', to: '2026-01-01' },
    { canFilterByUser: true }
  );
  assert.strictEqual(valid, false);
  assert.ok(errors.to);
});

test('validateActivityLogFilters: an unknown category is rejected', () => {
  const { valid, errors } = validateActivityLogFilters({ category: 'not_a_real_category' }, { canFilterByUser: true });
  assert.strictEqual(valid, false);
  assert.ok(errors.category);
});

test('validateActivityLogFilters: page_size above the max is rejected, not silently clamped', () => {
  const { valid, errors } = validateActivityLogFilters({ page_size: String(MAX_PAGE_SIZE + 1) }, { canFilterByUser: true });
  assert.strictEqual(valid, false);
  assert.ok(errors.page_size);
});

test('validateActivityLogFilters: page_size at the max is accepted', () => {
  const { valid, filters } = validateActivityLogFilters({ page_size: String(MAX_PAGE_SIZE) }, { canFilterByUser: true });
  assert.strictEqual(valid, true);
  assert.strictEqual(filters.pageSize, MAX_PAGE_SIZE);
});

test('validateActivityLogFilters: a non-integer page is rejected', () => {
  const { valid, errors } = validateActivityLogFilters({ page: '1.5' }, { canFilterByUser: true });
  assert.strictEqual(valid, false);
  assert.ok(errors.page);
});

test('validateActivityLogFilters: user_id is kept for a view_all caller', () => {
  const { valid, filters } = validateActivityLogFilters({ user_id: '7' }, { canFilterByUser: true });
  assert.strictEqual(valid, true);
  assert.strictEqual(filters.userId, 7);
});

test('validateActivityLogFilters: user_id is silently ignored (not an error) for a view_own-only caller', () => {
  const { valid, errors, filters } = validateActivityLogFilters({ user_id: '7' }, { canFilterByUser: false });
  assert.strictEqual(valid, true);
  assert.deepStrictEqual(errors, {});
  assert.strictEqual(filters.userId, undefined);
});

test('validateActivityLogFilters: a non-numeric user_id is still a validation error even when it would be ignored', () => {
  const { valid, errors } = validateActivityLogFilters({ user_id: 'abc' }, { canFilterByUser: false });
  assert.strictEqual(valid, false);
  assert.ok(errors.user_id);
});

test('summarizeDetails: login.failure turns a stored reason code into plain words', () => {
  assert.strictEqual(summarizeDetails('login.failure', { reason: 'not_found', email: 'x@test.local' }), 'no matching account');
});

test('summarizeDetails: user.role_changed maps stored role codes to current display names', () => {
  assert.strictEqual(
    summarizeDetails('user.role_changed', { from: 'production_manager', to: 'commercial_officer' }),
    'Role changed from Production Planner to Commercial Analyst'
  );
});

test('summarizeDetails: user.role_changed falls back to the raw code for an unrecognized role', () => {
  assert.strictEqual(
    summarizeDetails('user.role_changed', { from: 'admin', to: 'made_up_role' }),
    'Role changed from Admin to made_up_role'
  );
});

test('summarizeDetails: user.invited shows the invited email and the role\'s current display name', () => {
  assert.strictEqual(
    summarizeDetails('user.invited', { email: 'wdf.commercial.test@gmail.com', role: 'commercial_officer' }),
    'Invited wdf.commercial.test@gmail.com as Commercial Analyst'
  );
});

test('summarizeDetails: user.invited with only a role (no stored email) still reads naturally', () => {
  assert.strictEqual(summarizeDetails('user.invited', { role: 'production_manager' }), 'Invited as Production Planner');
});

test('summarizeDetails: emergency_admin.set shows the account email', () => {
  assert.strictEqual(summarizeDetails('emergency_admin.set', { email: 'admin@example.com' }), 'Account: admin@example.com');
  assert.strictEqual(summarizeDetails('emergency_admin.set', {}), null);
});

test('summarizeDetails: forecast_published reflects the actual stored model/horizon/data_up_to', () => {
  assert.strictEqual(
    summarizeDetails('forecast_published', { model_name: 'Prophet', horizon: 12, data_up_to: '2024-08-01' }),
    'Prophet, 12-month horizon, data to 2024-08-01'
  );
});

test('summarizeDetails: plan.save reflects the actual stored month/type/m3/version', () => {
  assert.strictEqual(
    summarizeDetails('plan.save', { month: '2026-11-01', plan_type: 'safe', chosen_m3: 1234567, version: 2 }),
    'safe for 2026-11-01: 1,234,567 m³ (v2)'
  );
});

test('summarizeDetails: stock.correct reflects the old and new amounts, date and reason', () => {
  assert.strictEqual(
    summarizeDetails('stock.correct', {
      recorded_on: '2026-11-01',
      old_stock_m3: 62_000_000,
      new_stock_m3: 61_500_000,
      reason: 'Meter misread on first entry.',
    }),
    '62,000,000 m³ → 61,500,000 m³ on 2026-11-01: Meter misread on first entry.'
  );
});

test('summarizeDetails: stock.remove reflects the amount, date and reason', () => {
  assert.strictEqual(
    summarizeDetails('stock.remove', {
      recorded_on: '2026-11-01',
      stock_m3: 61_500_000,
      reason: 'Entered for the wrong reservoir.',
    }),
    '61,500,000 m³ on 2026-11-01: Entered for the wrong reservoir.'
  );
});

test('summarizeDetails: an action with no case (e.g. login.success) returns null, not an invented sentence', () => {
  assert.strictEqual(summarizeDetails('login.success', { email: 'a@test.local' }), null);
});

test('summarizeDetails: audit.exported with no filters says so, with filters lists them', () => {
  assert.strictEqual(summarizeDetails('audit.exported', { filters: {} }), 'No filters applied');
  assert.strictEqual(
    summarizeDetails('audit.exported', { filters: { category: 'failed_sign_in', from: '2026-01-01' } }),
    'Filters: category=failed_sign_in, from=2026-01-01'
  );
});

test('getActor: a row with a real user_id always shows that user\'s current name', () => {
  assert.strictEqual(
    getActor({ userId: 3, actorName: 'Ada Lovelace', action: 'user.role_changed', email: null, canSeeEmail: true }),
    'Ada Lovelace'
  );
});

test('getActor: a genuine failed sign-in with no account shows "Unknown user (<email>)" to a view_all caller', () => {
  FAILED_SIGN_IN_ACTIONS.forEach((action) => {
    assert.strictEqual(
      getActor({ userId: null, actorName: null, action, email: 'ghost@test.local', canSeeEmail: true }),
      'Unknown user (ghost@test.local)'
    );
  });
});

test('getActor: the same failed sign-in shows plain "Unknown user" to a view_own-only caller (no email leak)', () => {
  assert.strictEqual(
    getActor({ userId: null, actorName: null, action: 'login.failure', email: 'ghost@test.local', canSeeEmail: false }),
    'Unknown user'
  );
});

test('getActor: a setup-script action with no user_id is "System (setup script)", never "Unknown user"', () => {
  ['user.invited', 'user.deactivated', 'emergency_admin.set', 'forecast_published'].forEach((action) => {
    assert.strictEqual(
      getActor({ userId: null, actorName: null, action, email: 'someone@example.com', canSeeEmail: true }),
      'System (setup script)'
    );
  });
});

test('escapeCsvField: plain values pass through unchanged', () => {
  assert.strictEqual(escapeCsvField('Signed in'), 'Signed in');
  assert.strictEqual(escapeCsvField(null), '');
  assert.strictEqual(escapeCsvField(undefined), '');
});

test('escapeCsvField: a comma, quote or newline forces quoting, with doubled internal quotes', () => {
  assert.strictEqual(escapeCsvField('Reason: "bad", really'), '"Reason: ""bad"", really"');
  assert.strictEqual(escapeCsvField('line one\nline two'), '"line one\nline two"');
});

test('buildCsv: builds a header row plus one row per entry, CRLF-joined', () => {
  const csv = buildCsv([{ a: 1, b: 'x' }, { a: 2, b: 'y, z' }], [
    { header: 'A', value: (r) => r.a },
    { header: 'B', value: (r) => r.b },
  ]);
  assert.strictEqual(csv, 'A,B\r\n1,x\r\n2,"y, z"');
});
