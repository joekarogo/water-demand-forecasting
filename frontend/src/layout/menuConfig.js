import {
  OverviewNavIcon,
  ForecastNavIcon,
  HistoryNavIcon,
  ProductionNavIcon,
  DistrictNavIcon,
  RevenueNavIcon,
  ScenariosNavIcon,
  UsersNavIcon,
  EvaluationNavIcon,
  ActivityNavIcon,
} from './icons';

// A menu item's `permission` is usually a single code, but can be an
// array when more than one permission grants access on its own (e.g.
// Activity log: audit:view_all OR audit:view_own) — `null` still means
// "everyone signed in", same as before.
export function hasMenuAccess(permission, userPermissions) {
  if (permission == null) return true;
  const granted = userPermissions || [];
  return Array.isArray(permission) ? permission.some((p) => granted.includes(p)) : granted.includes(permission);
}

// One line per page: { label, path, icon, permission }. The sidebar shows
// only items whose permission the signed-in user has — see
// src/session.js (GET /api/me's `permissions` array) and
// layout/Sidebar.js. The menu itself is the same for everyone; what's
// visible is purely permission-driven, not tied to any particular role —
// except Overview, whose `permission` is null: every signed-in user sees
// it regardless of role (Sidebar.js treats a null permission as "always
// visible"). getFirstPermittedPath below is unaffected by this, since
// `permissions.includes(null)` is never true — Overview is simply never
// matched as a fallback destination there, by construction.
export const MENU_ITEMS = [
  { label: 'Overview', path: '/overview', icon: OverviewNavIcon, permission: null },
  { label: 'Forecast', path: '/dashboard', icon: ForecastNavIcon, permission: 'forecast:view' },
  { label: 'Production Planning', path: '/production-planning', icon: ProductionNavIcon, permission: 'plan:view' },
  { label: 'Demand by district', path: '/demand-by-district', icon: DistrictNavIcon, permission: 'distribution:view' },
  { label: 'Revenue estimate', path: '/revenue', icon: RevenueNavIcon, permission: 'revenue:view' },
  { label: 'Revenue scenarios', path: '/revenue/scenarios', icon: ScenariosNavIcon, permission: 'revenue:view' },
  { label: 'Historical Analysis', path: '/data-overview', icon: HistoryNavIcon, permission: 'data:view' },
  { label: 'Users', path: '/users', icon: UsersNavIcon, permission: 'user:manage' },
  // Placed last so it always comes after every role's own operational
  // pages above, regardless of which of those a given role actually has.
  { label: 'Model evaluation', path: '/model-evaluation', icon: EvaluationNavIcon, permission: 'forecast:view' },
  // Last of all: everyone who can see activity at all (view_all or
  // view_own) can reach it, but it's not an "operational" page for any
  // role, so it belongs after every one of those above.
  { label: 'Activity log', path: '/activity-log', icon: ActivityNavIcon, permission: ['audit:view_all', 'audit:view_own'] },
];

// Where to send someone right after signing in: the first menu item
// (in the order above) whose permission they have. Array-permission
// items (like Activity log) are never matched as a landing destination
// here — Overview (permission: null) already isn't either, by the same
// `permissions.includes(item.permission)` check failing for a non-string.
export function getFirstPermittedPath(permissions) {
  const match = MENU_ITEMS.find((item) => permissions && permissions.includes(item.permission));
  return match ? match.path : '/dashboard';
}
