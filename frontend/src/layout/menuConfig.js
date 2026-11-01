import {
  OverviewNavIcon,
  ForecastNavIcon,
  HistoryNavIcon,
  ProductionNavIcon,
  DistrictNavIcon,
  RevenueNavIcon,
  UsersNavIcon,
} from './icons';

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
  { label: 'Historical Analysis', path: '/data-overview', icon: HistoryNavIcon, permission: 'data:view' },
  { label: 'Users', path: '/users', icon: UsersNavIcon, permission: 'user:manage' },
];

// Where to send someone right after signing in: the first menu item
// (in the order above) whose permission they have.
export function getFirstPermittedPath(permissions) {
  const match = MENU_ITEMS.find((item) => permissions && permissions.includes(item.permission));
  return match ? match.path : '/dashboard';
}
