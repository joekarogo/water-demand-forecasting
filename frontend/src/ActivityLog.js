import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import { RetryIcon, DownloadIcon } from './layout/icons';
import { formatDateTime } from './utils/format';
import { downloadTextFile } from './utils/download';
import './App.css';

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 400;

const CATEGORY_OPTIONS = [
  { value: '', label: 'All categories' },
  { value: 'sign_in', label: 'Sign-ins and sign-outs' },
  { value: 'failed_sign_in', label: 'Failed sign-in' },
  { value: 'emergency', label: 'Emergency sign-in' },
  { value: 'user_management', label: 'User management' },
  { value: 'planning', label: 'Production planning' },
  { value: 'stock', label: 'Storage readings' },
  { value: 'access_denied', label: 'Access denied' },
  { value: 'system', label: 'System' },
];

function dateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function ActivityLog() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const permissions = session?.permissions || [];
  const hasViewAll = permissions.includes('audit:view_all');
  const hasActivityAccess = hasViewAll || permissions.includes('audit:view_own');

  // Filters are seeded from the URL once, on first render — so a link
  // elsewhere in the app (e.g. Overview's alerts, using `days` as a
  // shorthand for "from N days ago") can land here pre-filtered.
  const initialParams = useRef(searchParams);
  const [from, setFrom] = useState(() => {
    const p = initialParams.current;
    const days = p.get('days');
    return p.get('from') || (days ? dateDaysAgo(Number(days)) : dateDaysAgo(30));
  });
  const [to, setTo] = useState(() => initialParams.current.get('to') || '');
  const [category, setCategory] = useState(() => initialParams.current.get('category') || '');
  const [userId, setUserId] = useState(() => initialParams.current.get('user_id') || '');
  const [searchInput, setSearchInput] = useState(() => initialParams.current.get('q') || '');
  const [q, setQ] = useState(() => initialParams.current.get('q') || '');
  const [page, setPage] = useState(() => Number(initialParams.current.get('page')) || 1);

  const [status, setStatus] = useState('loading'); // loading | ready | error | invalid
  const [errorReference, setErrorReference] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [result, setResult] = useState(null); // { rows, total, page, page_size, scope }
  const [userOptions, setUserOptions] = useState([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const handleAuthError = useCallback(
    (response) => {
      if (response.status === 401) {
        clearSession();
        navigate('/login', { replace: true, state: { message: 'Your session has expired. Please sign in again.' } });
        return true;
      }
      return false;
    },
    [navigate, clearSession]
  );

  // Debounce free-text search so every keystroke doesn't trigger a request.
  useEffect(() => {
    const timer = setTimeout(() => {
      setPage(1);
      setQ(searchInput);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const updateFilter = (setter, value) => {
    setPage(1);
    setter(value);
  };

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (category) params.set('category', category);
    if (hasViewAll && userId) params.set('user_id', userId);
    if (q) params.set('q', q);
    params.set('page', String(page));
    params.set('page_size', String(PAGE_SIZE));
    return params.toString();
  }, [from, to, category, userId, q, page, hasViewAll]);

  // Keeps the URL in sync with the current filters, so the page's state
  // is itself shareable/bookmarkable — mirrors buildQuery's own params.
  useEffect(() => {
    const next = {};
    if (from) next.from = from;
    if (to) next.to = to;
    if (category) next.category = category;
    if (hasViewAll && userId) next.user_id = userId;
    if (q) next.q = q;
    if (page > 1) next.page = String(page);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, category, userId, q, page, hasViewAll]);

  const fetchData = useCallback(async () => {
    setStatus('loading');
    setFieldErrors({});
    try {
      const response = await apiFetch(`/api/activity-log?${buildQuery()}`);
      if (handleAuthError(response)) return;
      const body = await response.json().catch(() => ({}));
      if (response.status === 400) {
        setFieldErrors(body.fields || {});
        setStatus('invalid');
        return;
      }
      if (!response.ok) {
        setErrorReference(body.reference || null);
        setStatus('error');
        return;
      }
      setResult(body);
      setStatus('ready');
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
    }
  }, [buildQuery, handleAuthError]);

  useEffect(() => {
    if (sessionLoading || !session || !hasActivityAccess) return;
    fetchData();
  }, [sessionLoading, session, hasActivityAccess, fetchData]);

  // The "User" filter, Admin (audit:view_all) only — a separate, small
  // request that never blocks the activity log itself if it fails (a
  // future role holding audit:view_all without user:manage would simply
  // not be offered this filter, rather than the whole page breaking).
  useEffect(() => {
    if (sessionLoading || !session || !hasViewAll) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiFetch('/api/users');
        if (!response.ok) return;
        const body = await response.json().catch(() => ({}));
        if (!cancelled) setUserOptions(body.users || []);
      } catch (err) {
        // ignore — the filter just won't be offered
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionLoading, session, hasViewAll]);

  const totalPages = result ? Math.max(1, Math.ceil(result.total / (result.page_size || PAGE_SIZE))) : 1;
  const subtitle = hasViewAll ? 'Everything that happened in the system' : 'Your own activity';

  // A plain <a href="/api/activity-log/export"> doesn't work in local dev:
  // the CRA dev server's proxy skips any request that looks like a page
  // navigation (an Accept: text/html GET), so clicking it just reloads
  // the app instead of downloading anything. Fetching through apiFetch
  // (same session cookie/CSRF handling as every other request) and
  // saving the response ourselves works in dev and in production alike.
  const handleExportCsv = async () => {
    setExporting(true);
    setExportError('');
    try {
      const response = await apiFetch(`/api/activity-log/export?${buildQuery()}`);
      if (handleAuthError(response)) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setExportError(body.error || 'Unable to export the activity log right now.');
        return;
      }
      const csv = await response.text();
      downloadTextFile(`activity-log-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    } catch (err) {
      setExportError('Unable to reach the server. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <AppLayout title="Activity log" subtitle={subtitle} requiredPermission={['audit:view_all', 'audit:view_own']}>
      <section className="card" aria-labelledby="activityTitle" style={{ padding: 20 }}>
        <h2 className="sr-only" id="activityTitle">
          Activity log
        </h2>
        <p className="field-hint" style={{ marginTop: 0 }}>
          Entries are recorded automatically and can't be edited or deleted.
        </p>

        <div className="controls" role="group" aria-label="Filter activity">
          <div className="field">
            <label htmlFor="fromDate">From</label>
            <input
              className="input"
              type="date"
              id="fromDate"
              value={from}
              onChange={(e) => updateFilter(setFrom, e.target.value)}
            />
            {fieldErrors.from && <span className="field-err">{fieldErrors.from}</span>}
          </div>
          <div className="field">
            <label htmlFor="toDate">To</label>
            <input
              className="input"
              type="date"
              id="toDate"
              value={to}
              onChange={(e) => updateFilter(setTo, e.target.value)}
            />
            {fieldErrors.to && <span className="field-err">{fieldErrors.to}</span>}
          </div>
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor="categoryFilter">Category</label>
            <select
              className="input"
              id="categoryFilter"
              value={category}
              onChange={(e) => updateFilter(setCategory, e.target.value)}
            >
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          {hasViewAll && userOptions.length > 0 && (
            <div className="field" style={{ minWidth: 180 }}>
              <label htmlFor="userFilter">User</label>
              <select
                className="input"
                id="userFilter"
                value={userId}
                onChange={(e) => updateFilter(setUserId, e.target.value)}
              >
                <option value="">All users</option>
                {userOptions.map((u) => (
                  <option key={u.user_id} value={u.user_id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor="activitySearch">Search</label>
            <input
              className="input"
              type="search"
              id="activitySearch"
              placeholder="Action, entity or details"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        </div>

        {status === 'loading' && (
          <div className="state-banner" role="status" aria-live="polite">
            <span className="state-banner-spinner" aria-hidden="true" />
            <div>Loading activity…</div>
          </div>
        )}

        {status === 'error' && (
          <>
            <div className="alert danger" role="alert" style={{ marginTop: 12 }}>
              <span aria-hidden="true">⚠</span>
              <span>
                Unable to load the activity log right now.
                {errorReference ? ` Reference ${errorReference}.` : ' If it keeps happening, tell your system administrator.'}
              </span>
            </div>
            <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} onClick={fetchData}>
              <RetryIcon />
              Retry
            </button>
          </>
        )}

        {status === 'invalid' && <p className="field-err">Fix the highlighted filter above and try again.</p>}

        {status === 'ready' && result && (
          <>
            <div className="card-head" style={{ padding: '14px 0 0' }}>
              <p className="card-sub" style={{ margin: 0 }}>
                {result.total} matching {result.total === 1 ? 'entry' : 'entries'}
              </p>
              <button type="button" className="btn" onClick={handleExportCsv} disabled={exporting}>
                <DownloadIcon />
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </div>
            {exportError && (
              <div className="alert danger" role="alert" style={{ marginTop: 10 }}>
                <span aria-hidden="true">⚠</span>
                <span>{exportError}</span>
              </div>
            )}

            {result.rows.length === 0 ? (
              <p className="field-hint">No activity matches these filters.</p>
            ) : (
              <div className="table-wrap">
                <table className="plan-table">
                  <caption className="sr-only">Activity matching the current filters, newest first.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Who</th>
                      <th scope="col">What</th>
                      <th scope="col">Details</th>
                      {hasViewAll && <th scope="col">IP address</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{formatDateTime(r.occurred_at)}</td>
                        <td>{r.actor}</td>
                        <td>{r.label}</td>
                        <td>{r.details || '—'}</td>
                        {hasViewAll && <td>{r.ip_address || '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {totalPages > 1 && (
              <div className="ctl-group" style={{ marginTop: 14, display: 'flex', width: '100%', justifyContent: 'space-between' }}>
                <button className="btn" type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  Previous
                </button>
                <span className="field-hint">
                  Page {result.page} of {totalPages}
                </span>
                <button className="btn" type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </AppLayout>
  );
}

export default ActivityLog;
