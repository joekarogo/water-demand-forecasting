import { ForecastNavIcon, HistoryNavIcon, ProductionNavIcon, DistrictNavIcon, UsersNavIcon } from './icons';

// One line per page: { label, path, icon, permission }. The sidebar shows
// only items whose permission the signed-in user has — see
// src/session.js (GET /api/me's `permissions` array) and
// layout/Sidebar.js. The menu itself is the same for everyone; what's
// visible is purely permission-driven, not tied to any particular role.
export const MENU_ITEMS = [
  { label: 'Forecast', path: '/dashboard', icon: ForecastNavIcon, permission: 'forecast:view' },
  { label: 'Production Planning', path: '/production-planning', icon: ProductionNavIcon, permission: 'plan:view' },
  { label: 'Demand by district', path: '/demand-by-district', icon: DistrictNavIcon, permission: 'distribution:view' },
  { label: 'Historical Analysis', path: '/data-overview', icon: HistoryNavIcon, permission: 'data:view' },
  { label: 'Users', path: '/users', icon: UsersNavIcon, permission: 'user:manage' },
];

// Where to send someone right after signing in: the first menu item
// (in the order above) whose permission they have.
export function getFirstPermittedPath(permissions) {
  const match = MENU_ITEMS.find((item) => permissions && permissions.includes(item.permission));
  return match ? match.path : '/dashboard';
}
