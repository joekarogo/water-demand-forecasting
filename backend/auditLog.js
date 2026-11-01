// Shared, pure (no DB access) logic for the audit trail: the one set of
// plain-language action labels used by both backend/overview.js's
// "Recent activity" list and the Activity Log page below, the
// category -> action-name mapping the Activity Log page's category
// filter uses, and filter/pagination validation plus the small
// formatting helpers the Activity Log route needs. Kept here, not
// inline in backend/app.js, so all of this is directly unit-testable —
// mirroring how backend/distribution.js/revenue.js/overview.js are
// structured.

const ACTION_LABELS = {
  'login.success': 'Signed in',
  'login.failure': 'Failed sign-in attempt',
  'emergency.login': 'Emergency sign-in',
  'emergency.login_failed': 'Failed emergency sign-in',
  logout: 'Signed out',
  'permission.denied': 'Permission denied',
  'user.invited': 'Invited a user',
  'user.role_changed': 'Changed a role',
  'user.deactivated': 'Deactivated a user',
  'user.reactivated': 'Reactivated a user',
  'user.job_title_changed': 'Changed a job title',
  'plan.save': 'Saved a production plan',
  'stock.record': 'Recorded stock',
  'audit.exported': 'Exported the activity log',
  // Written with no signed-in actor at all (user_id is NULL): an offline
  // setup script (database/create_emergency_admin.py) and the publish job
  // (ml/publish_forecast.py) respectively. See FAILED_SIGN_IN_ACTIONS below
  // for how the actor shown for these differs from a failed sign-in's.
  'emergency_admin.set': 'Emergency account set up',
  forecast_published: 'Forecast published',
};

// Every category the Activity Log page's filter offers, mapped to the
// concrete action names it covers. Every entry in ACTION_LABELS above must
// land in exactly one of these (enforced by a completeness test) — nothing
// is left deliberately uncategorized any more.
const CATEGORY_ACTIONS = {
  sign_in: ['login.success', 'logout'],
  failed_sign_in: ['login.failure'],
  emergency: ['emergency.login', 'emergency.login_failed'],
  user_management: [
    'user.invited',
    'user.role_changed',
    'user.deactivated',
    'user.reactivated',
    'user.job_title_changed',
    'emergency_admin.set',
  ],
  planning: ['plan.save'],
  stock: ['stock.record'],
  access_denied: ['permission.denied'],
  // Actions about the system/audit infrastructure itself, not about any
  // one user's account: an offline job publishing a forecast, and an
  // admin exporting the log's own contents.
  system: ['forecast_published', 'audit.exported'],
};

const CATEGORIES = Object.keys(CATEGORY_ACTIONS);

function getCategoryForAction(action) {
  for (const category of CATEGORIES) {
    if (CATEGORY_ACTIONS[category].includes(action)) return category;
  }
  return null;
}

// Only these two genuinely represent an anonymous visitor who tried (and
// failed) to sign in — the email in their details is the identity THEY
// claimed, so it's safe and useful to show it as "who". Every other
// action with no user_id (a setup script, a migration, an offline job)
// has no person behind it at all, so it gets a different actor below.
const FAILED_SIGN_IN_ACTIONS = ['login.failure', 'emergency.login_failed'];

// A role code as actually stored in the roles table (stable, never
// renamed) mapped to its CURRENT display name — kept here, not read from
// the database, because this module has no DB access and old audit rows
// (written before migration 007 renamed these) must still read with
// today's names, not whatever the role was called when the row was written.
const ROLE_LABELS = {
  admin: 'Admin',
  production_manager: 'Production Planner',
  commercial_officer: 'Commercial Analyst',
};
function roleLabel(roleCode) {
  return ROLE_LABELS[roleCode] || roleCode;
}

// Who did this? A row with a real user_id always shows that user's
// current name. A NULL user_id means no account was ever involved: for a
// genuine failed sign-in that's an anonymous visitor (show the email they
// tried, but only to a caller who can already see everyone's rows); for
// every other NULL-user_id action it isn't a person at all, so showing
// "Unknown user" would be misleading — it's a script or an offline job.
function getActor({ userId, actorName, action, email, canSeeEmail }) {
  if (userId !== null && userId !== undefined) return actorName || 'Unknown user';
  if (FAILED_SIGN_IN_ACTIONS.includes(action)) {
    return canSeeEmail && email ? `Unknown user (${email})` : 'Unknown user';
  }
  return 'System (setup script)';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;

function isValidDateString(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return false;
  // New Date() silently rolls an impossible day (e.g. Feb 30) into the
  // next real date instead of failing — round-tripping back to the same
  // ISO date string is what actually catches that.
  return date.toISOString().slice(0, 10) === value;
}

// query: the raw req.query object (every value a string, or undefined).
// canFilterByUser: whether the caller holds audit:view_all — only they
// may narrow to a specific user_id, since anyone with only
// audit:view_own ever sees their own rows regardless of this filter, so
// a user_id they send is silently ignored rather than rejected.
function validateActivityLogFilters(query, { canFilterByUser }) {
  const q = query || {};
  const errors = {};
  const filters = {};

  if (q.from !== undefined && q.from !== '') {
    if (!isValidDateString(q.from)) {
      errors.from = 'from must be a valid date (YYYY-MM-DD).';
    } else {
      filters.from = q.from;
    }
  }

  if (q.to !== undefined && q.to !== '') {
    if (!isValidDateString(q.to)) {
      errors.to = 'to must be a valid date (YYYY-MM-DD).';
    } else {
      filters.to = q.to;
    }
  }

  if (!errors.from && !errors.to && filters.from && filters.to && filters.from > filters.to) {
    errors.to = '"to" must not be before "from".';
  }

  if (q.category !== undefined && q.category !== '') {
    if (!CATEGORIES.includes(q.category)) {
      errors.category = `category must be one of: ${CATEGORIES.join(', ')}.`;
    } else {
      filters.category = q.category;
    }
  }

  if (q.q !== undefined && q.q !== '') {
    const trimmed = String(q.q).trim().slice(0, MAX_QUERY_LENGTH);
    if (trimmed) filters.q = trimmed;
  }

  if (q.user_id !== undefined && q.user_id !== '') {
    const userId = Number(q.user_id);
    if (!Number.isInteger(userId) || userId <= 0) {
      errors.user_id = 'user_id must be a positive integer.';
    } else if (canFilterByUser) {
      filters.userId = userId;
    }
  }

  let page = 1;
  if (q.page !== undefined && q.page !== '') {
    const parsed = Number(q.page);
    if (!Number.isInteger(parsed) || parsed < 1) {
      errors.page = 'page must be a positive integer.';
    } else {
      page = parsed;
    }
  }

  let pageSize = DEFAULT_PAGE_SIZE;
  if (q.page_size !== undefined && q.page_size !== '') {
    const parsed = Number(q.page_size);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PAGE_SIZE) {
      errors.page_size = `page_size must be an integer between 1 and ${MAX_PAGE_SIZE}.`;
    } else {
      pageSize = parsed;
    }
  }

  filters.page = page;
  filters.pageSize = pageSize;

  return { valid: Object.keys(errors).length === 0, errors, filters };
}

// A short, plain-words gloss of an event's stored JSONB details — the
// label already says WHAT kind of event it was; this adds whatever
// extra the stored details actually capture, never anything invented.
// Returns null when there's nothing to add beyond the label.
function summarizeDetails(action, details) {
  const d = details || {};
  switch (action) {
    case 'login.failure': {
      const reasons = {
        invalid_token: 'invalid Google sign-in token',
        email_not_verified: "the Google account's email isn't verified",
        not_found: 'no matching account',
        deactivated: 'the account is deactivated',
        wrong_provider: "the account doesn't use Google sign-in",
        sub_mismatch: 'a different Google account is already linked',
      };
      return reasons[d.reason] || d.reason || null;
    }
    case 'emergency.login':
      return d.note || null;
    case 'permission.denied':
      return d.permission ? `Needed "${d.permission}" for ${d.method || ''} ${d.path || ''}`.trim() : null;
    case 'user.invited':
      // The invited person's email lives only in this row's details — for
      // an invite with no signed-in actor (the system; see getActor
      // above) it's the only place that email can show up at all, but
      // it's shown here for every invite, not only that case.
      if (!d.email && !d.role) return null;
      return ['Invited', d.email, d.role ? `as ${roleLabel(d.role)}` : null].filter(Boolean).join(' ');
    case 'user.role_changed':
      return d.from && d.to ? `Role changed from ${roleLabel(d.from)} to ${roleLabel(d.to)}` : null;
    case 'user.deactivated':
      return d.reason ? `Reason: ${d.reason}` : null;
    case 'user.reactivated':
      return (
        [d.new_status ? `Now "${d.new_status}"` : null, d.reason ? `reason: ${d.reason}` : null]
          .filter(Boolean)
          .join('; ') || null
      );
    case 'user.job_title_changed':
      return 'job_title' in d ? `New job title: ${d.job_title ? `"${d.job_title}"` : '(cleared)'}` : null;
    case 'plan.save':
      return d.month
        ? `${d.plan_type || 'plan'} for ${d.month}: ${Number(d.chosen_m3).toLocaleString('en-US')} m³ (v${d.version})`
        : null;
    case 'stock.record':
      return d.recorded_on != null ? `${Number(d.stock_m3).toLocaleString('en-US')} m³ on ${d.recorded_on}` : null;
    case 'audit.exported': {
      const entries = Object.entries(d.filters || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
      return entries.length > 0 ? `Filters: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}` : 'No filters applied';
    }
    case 'emergency_admin.set':
      return d.email ? `Account: ${d.email}` : null;
    case 'forecast_published':
      return (
        [d.model_name, d.horizon ? `${d.horizon}-month horizon` : null, d.data_up_to ? `data to ${d.data_up_to}` : null]
          .filter(Boolean)
          .join(', ') || null
      );
    default:
      return null;
  }
}

// RFC-4180-ish escaping: a field needs quoting if it contains a comma, a
// double quote or a line break; an embedded double quote doubles up.
function escapeCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// columns: [{ header, value(row) }]
function buildCsv(rows, columns) {
  const lines = [columns.map((c) => escapeCsvField(c.header)).join(',')];
  rows.forEach((row) => {
    lines.push(columns.map((c) => escapeCsvField(c.value(row))).join(','));
  });
  return lines.join('\r\n');
}

module.exports = {
  ACTION_LABELS,
  CATEGORY_ACTIONS,
  CATEGORIES,
  FAILED_SIGN_IN_ACTIONS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  getCategoryForAction,
  getActor,
  validateActivityLogFilters,
  summarizeDetails,
  escapeCsvField,
  buildCsv,
};
