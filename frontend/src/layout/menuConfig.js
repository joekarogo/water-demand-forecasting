import { ForecastNavIcon, HistoryNavIcon } from './icons';

// One line per future page: { label, path, icon, roles }. roles: null means
// every signed-in role can see it; otherwise an array of allowed roles.
export const MENU_ITEMS = [
  { label: 'Forecast', path: '/dashboard', icon: ForecastNavIcon, roles: null },
  { label: 'Historical Analysis', path: '/data-overview', icon: HistoryNavIcon, roles: ['admin'] },
];

export const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Production Manager',
  commercial_officer: 'Commercial Officer',
};
