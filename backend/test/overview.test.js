const test = require('node:test');
const assert = require('node:assert/strict');
const { OVERVIEW_THRESHOLDS, productionAlerts, revenueAlerts, userManageAlerts } = require('../overview');

test('productionAlerts: one warning per unplanned month', () => {
  const alerts = productionAlerts({
    unplannedMonths: [
      { month: '2026-11-01', label: 'November 2026' },
      { month: '2026-12-01', label: 'December 2026' },
    ],
    daysOfCover: null,
    daysSinceStock: 0,
  });
  const unplanned = alerts.filter((a) => a.link.startsWith('/production-planning?month='));
  assert.strictEqual(unplanned.length, 2);
  assert.strictEqual(unplanned[0].level, 'warning');
  assert.strictEqual(unplanned[0].link, '/production-planning?month=2026-11-01');
});

test('productionAlerts: days of cover exactly at the warning threshold (30) is not yet a warning', () => {
  const alerts = productionAlerts({ unplannedMonths: [], daysOfCover: 30, daysSinceStock: 0 });
  assert.strictEqual(alerts.filter((a) => a.link === '/production-planning' && a.level !== 'info').length, 0);
});

test('productionAlerts: 29 days of cover is a warning, not an alert', () => {
  const alerts = productionAlerts({ unplannedMonths: [], daysOfCover: 29, daysSinceStock: 0 });
  const cover = alerts.find((a) => a.message.includes('days of stock remain'));
  assert.strictEqual(cover.level, 'warning');
});

test('productionAlerts: days of cover exactly at the alert threshold (15) is still only a warning', () => {
  const alerts = productionAlerts({ unplannedMonths: [], daysOfCover: 15, daysSinceStock: 0 });
  const cover = alerts.find((a) => a.message.includes('days of stock remain'));
  assert.strictEqual(cover.level, 'warning');
});

test('productionAlerts: 14 days of cover is an alert, and only an alert (never also a warning)', () => {
  const alerts = productionAlerts({ unplannedMonths: [], daysOfCover: 14, daysSinceStock: 0 });
  const coverAlerts = alerts.filter((a) => a.message.includes('days of stock remain'));
  assert.strictEqual(coverAlerts.length, 1);
  assert.strictEqual(coverAlerts[0].level, 'alert');
});

test('productionAlerts: null days of cover raises no days-of-cover alert at all', () => {
  const alerts = productionAlerts({ unplannedMonths: [], daysOfCover: null, daysSinceStock: 0 });
  assert.strictEqual(alerts.filter((a) => a.message.includes('days of stock remain')).length, 0);
});

test('productionAlerts: stock recorded exactly 30 days ago is still fresh enough', () => {
  const alerts = productionAlerts({ unplannedMonths: [], daysOfCover: null, daysSinceStock: 30 });
  assert.strictEqual(alerts.filter((a) => a.message.includes('No stock has been recorded')).length, 0);
});

test('productionAlerts: stock recorded 31 days ago is stale', () => {
  const alerts = productionAlerts({ unplannedMonths: [], daysOfCover: null, daysSinceStock: 31 });
  const stale = alerts.find((a) => a.message.includes('No stock has been recorded'));
  assert.strictEqual(stale.level, 'info');
});

test('productionAlerts: no stock ever recorded (null) is also stale', () => {
  const alerts = productionAlerts({ unplannedMonths: [], daysOfCover: null, daysSinceStock: null });
  assert.strictEqual(alerts.filter((a) => a.message.includes('No stock has been recorded')).length, 1);
});

test('revenueAlerts: not-priced exactly at 5% raises no warning', () => {
  const alerts = revenueAlerts({ notPricedPct: 5 });
  assert.strictEqual(alerts.filter((a) => a.level === 'warning').length, 0);
});

test('revenueAlerts: not-priced at 5.1% raises a warning', () => {
  const alerts = revenueAlerts({ notPricedPct: 5.1 });
  assert.strictEqual(alerts.filter((a) => a.level === 'warning').length, 1);
});

test('revenueAlerts: the tariff-vintage info alert always appears', () => {
  const alerts = revenueAlerts({ notPricedPct: 0 });
  assert.ok(alerts.some((a) => a.level === 'info' && a.message.includes('July 2024')));
});

test('userManageAlerts: zero failed attempts raises no warning', () => {
  const alerts = userManageAlerts({ invitedNeverSignedInNames: [], failedAttempts: 0, daysSinceEmergencyLogin: null });
  assert.strictEqual(alerts.length, 0);
});

test('userManageAlerts: exactly one failed attempt raises a warning with no link yet', () => {
  const alerts = userManageAlerts({ invitedNeverSignedInNames: [], failedAttempts: 1, daysSinceEmergencyLogin: null });
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].level, 'warning');
  assert.strictEqual(alerts[0].link, undefined);
  assert.strictEqual(alerts[0].linkText, undefined);
});

test('userManageAlerts: one invited-never-signed-in user is named by name', () => {
  const alerts = userManageAlerts({ invitedNeverSignedInNames: ['Kate'], failedAttempts: 0, daysSinceEmergencyLogin: null });
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].level, 'info');
  assert.strictEqual(alerts[0].link, '/users');
  assert.strictEqual(alerts[0].message, "Kate has been invited but hasn't signed in yet.");
});

test('userManageAlerts: two invited-never-signed-in users are joined with "and"', () => {
  const alerts = userManageAlerts({
    invitedNeverSignedInNames: ['Kate', 'Tom'],
    failedAttempts: 0,
    daysSinceEmergencyLogin: null,
  });
  assert.strictEqual(alerts[0].message, "Kate and Tom have been invited but haven't signed in yet.");
});

test('userManageAlerts: three invited-never-signed-in users are Oxford-joined', () => {
  const alerts = userManageAlerts({
    invitedNeverSignedInNames: ['Kate', 'Tom', 'Priya'],
    failedAttempts: 0,
    daysSinceEmergencyLogin: null,
  });
  assert.strictEqual(alerts[0].message, "Kate, Tom and Priya have been invited but haven't signed in yet.");
});

test('userManageAlerts: beyond three names, the rest are folded into "+N more"', () => {
  const alerts = userManageAlerts({
    invitedNeverSignedInNames: ['Kate', 'Tom', 'Priya', 'Dan', 'Sam'],
    failedAttempts: 0,
    daysSinceEmergencyLogin: null,
  });
  assert.strictEqual(alerts[0].message, "Kate, Tom and Priya, +2 more have been invited but haven't signed in yet.");
});

test('userManageAlerts: an emergency login exactly 30 days ago still warns, with no link yet', () => {
  const alerts = userManageAlerts({ invitedNeverSignedInNames: [], failedAttempts: 0, daysSinceEmergencyLogin: 30 });
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].level, 'warning');
  assert.strictEqual(alerts[0].link, undefined);
  assert.strictEqual(alerts[0].linkText, undefined);
});

test('userManageAlerts: an emergency login 31 days ago no longer warns', () => {
  const alerts = userManageAlerts({ invitedNeverSignedInNames: [], failedAttempts: 0, daysSinceEmergencyLogin: 31 });
  assert.strictEqual(alerts.length, 0);
});

test('every alert that has a link carries non-empty, visible link text', () => {
  const all = [
    ...productionAlerts({
      unplannedMonths: [{ month: '2026-11-01', label: 'November 2026' }],
      daysOfCover: 10,
      daysSinceStock: 40,
    }),
    ...revenueAlerts({ notPricedPct: 10 }),
    ...userManageAlerts({ invitedNeverSignedInNames: ['Kate'], failedAttempts: 1, daysSinceEmergencyLogin: 1 }),
  ];
  assert.ok(all.length > 0);
  all.forEach((a) => {
    if (a.link !== undefined) {
      assert.strictEqual(typeof a.linkText, 'string');
      assert.ok(a.linkText.length > 0);
    } else {
      assert.strictEqual(a.linkText, undefined);
    }
  });
  // The failed-attempts and emergency-login alerts have no link yet
  // (nothing on the Users page shows those events) — confirm at least
  // one alert in this mixed batch is deliberately link-less.
  assert.ok(all.some((a) => a.link === undefined));
});

test('OVERVIEW_THRESHOLDS exposes every threshold the rules above depend on', () => {
  assert.strictEqual(OVERVIEW_THRESHOLDS.days_of_cover_warning_days, 30);
  assert.strictEqual(OVERVIEW_THRESHOLDS.days_of_cover_alert_days, 15);
  assert.strictEqual(OVERVIEW_THRESHOLDS.stock_stale_days, 30);
  assert.strictEqual(OVERVIEW_THRESHOLDS.not_priced_pct_warning, 5);
  assert.strictEqual(OVERVIEW_THRESHOLDS.emergency_login_window_days, 30);
  assert.strictEqual(OVERVIEW_THRESHOLDS.audit_window_days, 7);
});
