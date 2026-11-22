// Pure functions for the Overview home page — no database access here;
// see backend/app.js for the SQL that turns forecasts, production_plans,
// stock_entries, consumption_detail and audit_log into the plain
// numbers these take as input. Kept here (not inline in app.js) so the
// alert thresholds and their boundary conditions are directly testable,
// mirroring how backend/distribution.js and backend/revenue.js are
// structured.

// Every threshold an alert rule below depends on, in one place — also
// returned by GET /api/overview itself, so the frontend's "How alerts
// work" tip always reflects the rules actually in force, not a second
// copy of these numbers hardcoded on the frontend.
const OVERVIEW_THRESHOLDS = {
  days_of_cover_warning_days: 30,
  days_of_cover_alert_days: 15,
  stock_stale_days: 30,
  not_priced_pct_warning: 5,
  emergency_login_window_days: 30,
  audit_window_days: 7,
};

// unplannedMonths: [{ month: 'YYYY-MM-DD', label: 'November 2026' }, ...]
// daysOfCover / daysSinceStock: number or null (null means "unknown", not
// zero — never treated as a problem on its own, except daysSinceStock
// null also means "no stock has ever been recorded", which IS a problem).
function productionAlerts({ unplannedMonths, daysOfCover, daysSinceStock }) {
  const alerts = [];

  unplannedMonths.forEach((m) => {
    alerts.push({
      level: 'warning',
      message: `No production plan saved for ${m.label}.`,
      link: `/production-planning?month=${m.month}`,
      linkText: 'Open Production Planning',
    });
  });

  // Alert supersedes warning — a month is either critically low or just
  // low, never reported as both.
  if (daysOfCover != null) {
    if (daysOfCover < OVERVIEW_THRESHOLDS.days_of_cover_alert_days) {
      alerts.push({
        level: 'alert',
        message: `Only ${daysOfCover} days of supply remain at the planned production rate.`,
        link: '/production-planning',
        linkText: 'Open Production Planning',
      });
    } else if (daysOfCover < OVERVIEW_THRESHOLDS.days_of_cover_warning_days) {
      alerts.push({
        level: 'warning',
        message: `Only ${daysOfCover} days of supply remain at the planned production rate.`,
        link: '/production-planning',
        linkText: 'Open Production Planning',
      });
    }
  }

  if (daysSinceStock == null || daysSinceStock > OVERVIEW_THRESHOLDS.stock_stale_days) {
    alerts.push({
      level: 'info',
      message: 'No storage reading has been recorded in the last 30 days.',
      link: '/production-planning',
      linkText: 'Open Production Planning',
    });
  }

  return alerts;
}

function revenueAlerts({ notPricedPct }) {
  const alerts = [];

  if (notPricedPct != null && notPricedPct > OVERVIEW_THRESHOLDS.not_priced_pct_warning) {
    alerts.push({
      level: 'warning',
      message: `${notPricedPct.toFixed(1)}% of this month's volume isn't priced.`,
      link: '/revenue',
      linkText: 'Open Revenue estimate',
    });
  }

  alerts.push({
    level: 'info',
    message: 'Prices are July 2024 tariffs; 2025 increases are not included.',
    link: '/revenue',
    linkText: 'Open Revenue estimate',
  });

  return alerts;
}

// Names up to the first 3, Oxford-joined ("A", "A and B", "A, B and C"),
// with any remainder past 3 folded into a trailing "+N more" rather than
// ever naming a 4th+ person.
function joinNamesUpToThree(names) {
  const shown = names.slice(0, 3);
  const extra = names.length - shown.length;
  let joined;
  if (shown.length <= 1) {
    joined = shown[0] || '';
  } else if (shown.length === 2) {
    joined = `${shown[0]} and ${shown[1]}`;
  } else {
    joined = `${shown[0]}, ${shown[1]} and ${shown[2]}`;
  }
  return extra > 0 ? `${joined}, +${extra} more` : joined;
}

function userManageAlerts({ invitedNeverSignedInNames, failedAttempts, daysSinceEmergencyLogin }) {
  const alerts = [];
  const names = invitedNeverSignedInNames || [];

  if (names.length > 0) {
    const namePart = joinNamesUpToThree(names);
    const verb = names.length === 1 ? 'has' : 'have';
    const contraction = names.length === 1 ? "hasn't" : "haven't";
    alerts.push({
      level: 'info',
      message: `${namePart} ${verb} been invited but ${contraction} signed in yet.`,
      link: '/users',
      linkText: 'Open Users',
    });
  }

  if (failedAttempts > 0) {
    alerts.push({
      level: 'warning',
      message: `${failedAttempts} failed sign-in attempt${failedAttempts === 1 ? '' : 's'} in the last ${
        OVERVIEW_THRESHOLDS.audit_window_days
      } days.`,
      link: `/activity-log?category=failed_sign_in&days=${OVERVIEW_THRESHOLDS.audit_window_days}`,
      linkText: 'Open Activity log',
    });
  }

  if (daysSinceEmergencyLogin != null && daysSinceEmergencyLogin <= OVERVIEW_THRESHOLDS.emergency_login_window_days) {
    alerts.push({
      level: 'warning',
      message: 'An emergency sign-in happened in the last 30 days.',
      link: `/activity-log?category=emergency&days=${OVERVIEW_THRESHOLDS.emergency_login_window_days}`,
      linkText: 'Open Activity log',
    });
  }

  return alerts;
}

module.exports = {
  OVERVIEW_THRESHOLDS,
  productionAlerts,
  revenueAlerts,
  userManageAlerts,
};
