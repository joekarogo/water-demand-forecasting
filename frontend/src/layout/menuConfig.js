import { ForecastNavIcon, HistoryNavIcon, ProductionNavIcon } from './icons';

// One line per future page: { label, path, icon, roles }. roles: null means
// every signed-in role can see it; otherwise an array of allowed roles.
//
// Production Planning is listed for the 'manager' role specifically
// (rather than by permission) because Admin no longer has plan:view —
// permission-based menu filtering is planned for Module 1.
export const MENU_ITEMS = [
  { label: 'Forecast', path: '/dashboard', icon: ForecastNavIcon, roles: null },
  { label: 'Production Planning', path: '/production-planning', icon: ProductionNavIcon, roles: ['manager'] },
  { label: 'Historical Analysis', path: '/data-overview', icon: HistoryNavIcon, roles: ['admin'] },
];

export const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Production Manager',
  commercial_officer: 'Commercial Officer',
};
