import { getFirstPermittedPath } from './layout/menuConfig';

// Permission sets reconstructed from database/schema/001_foundation.sql,
// 003_production_planning.sql and 004_accounts.sql (see
// docs/testing_evidence.md) — what each role actually has today.
const ADMIN_PERMISSIONS = [
  'forecast:view',
  'user:manage',
  'settings:edit',
  'audit:view_all',
  'report:view',
  'report:export',
  'data:view',
];
const PRODUCTION_MANAGER_PERMISSIONS = [
  'forecast:view',
  'plan:view',
  'plan:create',
  'stock:create',
  'distribution:view',
  'audit:view_own',
  'report:view',
  'report:export',
];
const COMMERCIAL_OFFICER_PERMISSIONS = [
  'forecast:view',
  'tariff:view',
  'tariff:edit',
  'revenue:view',
  'audit:view_own',
  'report:view',
  'report:export',
];

test('admin lands on Forecast first', () => {
  expect(getFirstPermittedPath(ADMIN_PERMISSIONS)).toBe('/dashboard');
});

test('production manager lands on Forecast first', () => {
  expect(getFirstPermittedPath(PRODUCTION_MANAGER_PERMISSIONS)).toBe('/dashboard');
});

test('commercial officer lands on Forecast first', () => {
  expect(getFirstPermittedPath(COMMERCIAL_OFFICER_PERMISSIONS)).toBe('/dashboard');
});

test('skips to the next menu item when the user lacks forecast:view', () => {
  expect(getFirstPermittedPath(['plan:view'])).toBe('/production-planning');
  expect(getFirstPermittedPath(['data:view'])).toBe('/data-overview');
});

test('falls back to /dashboard with no matching permission', () => {
  expect(getFirstPermittedPath([])).toBe('/dashboard');
  expect(getFirstPermittedPath(undefined)).toBe('/dashboard');
});
