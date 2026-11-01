import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ComposedChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import InfoTip from './components/InfoTip';
import {
  RetryIcon,
  ErrorTriangleIcon,
  InfoIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  EmptyForecastIcon,
} from './layout/icons';
import {
  formatMonthLong,
  formatMonthShort,
  formatDateLong,
  formatDateTime,
  formatPublishedDate,
  formatDistrictName,
  fmtInt,
  fmtMillions,
  fmtTRYMillions,
} from './utils/format';
import './App.css';

const API_URL = '/api/overview';

// The level each alert carries decides its icon AND its CSS variant —
// never colour alone, since the icon + its text label (below) carry the
// same information the colour does.
const ALERT_ICONS = { info: InfoIcon, warning: AlertCircleIcon, alert: ErrorTriangleIcon };
const ALERT_VARIANTS = { info: 'info', warning: 'amber', alert: 'danger' };

function Overview() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();

  const [status, setStatus] = useState('loading'); // loading | ready | empty | error
  const [errorReference, setErrorReference] = useState(null);
  const [data, setData] = useState(null);

  const handleAuthError = useCallback(
    (response) => {
      if (response.status === 401) {
        clearSession();
        navigate('/login', {
          replace: true,
          state: { message: 'Your session has expired. Please sign in again.' },
        });
        return true;
      }
      return false;
    },
    [navigate, clearSession]
  );

  const fetchData = useCallback(async () => {
    setStatus('loading');
    try {
      const response = await apiFetch(API_URL);
      if (handleAuthError(response)) return;
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrorReference(body.reference || null);
        setStatus('error');
        return;
      }
      setData(body);
      setStatus(Object.keys(body.sections || {}).length === 0 ? 'empty' : 'ready');
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
    }
  }, [handleAuthError]);

  // Overview has no permission gate of its own — every signed-in user
  // can call it, so the only guard here is that a session exists at all.
  useEffect(() => {
    if (sessionLoading || !session) return;
    fetchData();
  }, [sessionLoading, session, fetchData]);

  const sections = useMemo(() => data?.sections || {}, [data]);

  const kpis = useMemo(() => {
    if (!data) return [];
    const list = [];

    if (sections.forecast) {
      list.push({
        label: 'Forecast for the first month',
        value: `${fmtMillions(sections.forecast.predicted)}M m³`,
        help: `${formatMonthLong(sections.forecast.first_month)} · range ${fmtMillions(
          sections.forecast.lower
        )}–${fmtMillions(sections.forecast.upper)}M m³`,
      });
    }

    if (sections.production) {
      list.push({
        label: 'Days of stock remaining',
        value: sections.production.days_of_cover != null ? `${fmtInt(sections.production.days_of_cover)} days` : '—',
        help: sections.production.latest_stock
          ? `at the planned rate, as of ${formatDateLong(sections.production.latest_stock.recorded_on)}`
          : 'No stock recorded yet',
      });
      const plannedCount = sections.production.next_months.filter((m) => m.plan).length;
      list.push({
        label: 'Plans saved (next 3 months)',
        value: `${plannedCount} / ${sections.production.next_months.length}`,
        help: 'Production Planning',
      });
    }

    if (sections.distribution) {
      list.push({
        label: 'Largest district',
        value: formatDistrictName(sections.distribution.district),
        help: `${sections.distribution.share_pct.toFixed(1)}% of the city · ${fmtMillions(
          sections.distribution.forecast_m3
        )}M m³`,
      });
    }

    if (sections.revenue) {
      list.push({
        label: 'Expected revenue',
        value: fmtTRYMillions(sections.revenue.total.mid),
        help: `low–high ${fmtTRYMillions(sections.revenue.total.low)}–${fmtTRYMillions(sections.revenue.total.high)}`,
      });
      list.push({
        label: 'Not priced',
        value: `${sections.revenue.not_priced_pct.toFixed(1)}%`,
        help: "of this month's billed volume",
      });
      list.push({
        label: 'Next 12 months',
        value: fmtTRYMillions(sections.revenue.twelve_month_total_mid),
        help: 'Expected revenue, this forecast',
      });
    }

    if (sections.users) {
      const totalActive = sections.users.active_by_role.reduce((sum, r) => sum + r.count, 0);
      list.push({
        label: 'Active users',
        value: fmtInt(totalActive),
        help: sections.users.active_by_role.map((r) => `${r.count} ${r.role_label}`).join(' · ') || 'None yet',
      });
      list.push({
        label: 'Sign-ins (last 7 days)',
        value: fmtInt(sections.users.sign_ins_last_7_days),
        help: `${fmtInt(sections.users.failed_attempts_last_7_days)} failed attempt${
          sections.users.failed_attempts_last_7_days === 1 ? '' : 's'
        }`,
      });
      list.push({
        label: 'Latest forecast',
        value: data.published_at ? formatPublishedDate(data.published_at) : '—',
        help: data.data_up_to ? `data to ${formatMonthLong(data.data_up_to)}` : 'No published forecast yet',
      });
    }

    return list.slice(0, 4);
  }, [data, sections]);

  const subtitle = data?.first_month ? `Your summary for ${formatMonthLong(data.first_month)}` : 'Your summary';

  return (
    <AppLayout title="Overview" subtitle={subtitle}>
      {status === 'loading' && (
        <>
          <div className="state-banner" role="status" aria-live="polite">
            <span className="state-banner-spinner" aria-hidden="true" />
            <div>Loading your overview…</div>
          </div>
          <section className="kpis" aria-hidden="true">
            {[50, 55, 60, 50].map((w, i) => (
              <div className="card sk-kpi" key={i}>
                <div className="sk" style={{ width: `${w}%`, height: 12 }} />
                <div className="sk" style={{ width: '60%', height: 28 }} />
                <div className="sk" style={{ width: '80%', height: 10 }} />
              </div>
            ))}
          </section>
        </>
      )}

      {status === 'error' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>Your overview couldn't be loaded.</h2>
          <p>
            Try again in a moment.
            {errorReference
              ? ` If it keeps happening, tell your system administrator (reference ${errorReference}).`
              : ' If it keeps happening, tell your system administrator.'}
          </p>
          <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} onClick={fetchData}>
            <RetryIcon />
            Retry
          </button>
        </section>
      )}

      {status === 'empty' && (
        <section className="card error-card" role="status">
          <span className="empty-icon" aria-hidden="true">
            <EmptyForecastIcon />
          </span>
          <h2>No summary is available yet</h2>
          <p>Your account doesn't have anything to show here yet. Contact your system administrator if that's unexpected.</p>
        </section>
      )}

      {status === 'ready' && data && (
        <>
          <p className="published">
            <span className="dot" aria-hidden="true" style={{ background: '#94a3b8' }} />
            <span>
              Data runs to {data.data_up_to ? formatMonthLong(data.data_up_to) : '—'}; the first forecast month is
              treated as the current planning month.
            </span>
          </p>

          <section className="card" aria-labelledby="attentionTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="attentionTitle">
                  Needs your attention
                </h2>
              </div>
              <InfoTip id="tipAlerts" label="How alerts work">
                <b>How alerts work</b>
                <br />
                A production month warns once fewer than {data.thresholds.days_of_cover_warning_days} days of stock
                remain at the planned rate, and alerts below {data.thresholds.days_of_cover_alert_days} days.
                <br />
                Stock gets a reminder if nothing's been recorded in the last {data.thresholds.stock_stale_days} days.
                <br />
                Revenue warns once more than {data.thresholds.not_priced_pct_warning}% of a month's volume isn't
                priced.
                <br />
                Sign-in figures cover the last {data.thresholds.audit_window_days} days; an emergency sign-in keeps
                warning for {data.thresholds.emergency_login_window_days} days afterwards.
              </InfoTip>
            </div>

            {data.alerts.length === 0 ? (
              <div className="state-banner" role="status" style={{ marginTop: 10 }}>
                <span aria-hidden="true">
                  <CheckCircleIcon />
                </span>
                <div>Nothing needs your attention.</div>
              </div>
            ) : (
              <ul className="overview-alerts">
                {data.alerts.map((a, i) => {
                  const Icon = ALERT_ICONS[a.level] || InfoIcon;
                  const variant = ALERT_VARIANTS[a.level] || 'amber';
                  const body = (
                    <>
                      <span aria-hidden="true">
                        <Icon />
                      </span>
                      <span className="sr-only">{a.level}: </span>
                      <span className="alert-message">{a.message}</span>
                      {a.link && <span className="alert-go">{a.linkText}</span>}
                    </>
                  );
                  return (
                    <li key={i}>
                      {a.link ? (
                        <Link to={a.link} className={`alert ${variant}`}>
                          {body}
                        </Link>
                      ) : (
                        <div className={`alert ${variant}`}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="kpis" aria-label="Key figures">
            {kpis.map((k, i) => (
              <article className={`card kpi${i === 0 ? ' accent' : ''}`} key={k.label}>
                <div className="kpi-label">{k.label}</div>
                <div className="kpi-value">{k.value}</div>
                <div className="kpi-help">{k.help}</div>
              </article>
            ))}
          </section>

          {sections.production && (
            <section className="card" aria-labelledby="prodChartTitle">
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="prodChartTitle">
                    12-month forecast
                  </h2>
                  <p className="card-sub">Months with a saved production plan are marked.</p>
                </div>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={sections.production.all_months} margin={{ top: 20, right: 20, bottom: 10, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                    <XAxis
                      dataKey="month"
                      tickFormatter={formatMonthShort}
                      tick={{ fontSize: 11, fill: '#475569' }}
                      interval="preserveStartEnd"
                      minTickGap={20}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#475569' }}
                      tickFormatter={(value) => `${(value / 1_000_000).toFixed(0)}M`}
                    />
                    <Tooltip
                      formatter={(value) => [`${fmtMillions(value)}M m³`, 'Forecast']}
                      labelFormatter={formatMonthLong}
                    />
                    <Bar dataKey="forecast_m3" name="Forecast" radius={[3, 3, 0, 0]}>
                      {sections.production.all_months.map((m) => (
                        <Cell key={m.month} fill={m.has_plan ? '#0b5c8f' : '#c3d5e3'} />
                      ))}
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="legend" aria-hidden="true">
                <span>
                  <i style={{ width: 14, height: 11, background: '#0b5c8f', borderRadius: 2, display: 'inline-block' }} />
                  Plan saved
                </span>
                <span>
                  <i style={{ width: 14, height: 11, background: '#c3d5e3', borderRadius: 2, display: 'inline-block' }} />
                  No plan yet
                </span>
              </div>
              <p className="field-hint" style={{ padding: '0 20px' }}>
                {sections.production.all_months.some((m) => m.has_plan)
                  ? `Plan saved for: ${sections.production.all_months
                      .filter((m) => m.has_plan)
                      .map((m) => formatMonthShort(m.month))
                      .join(', ')}.`
                  : 'No months have a saved plan yet.'}
              </p>
            </section>
          )}

          {sections.revenue && (
            <section className="card" aria-labelledby="revChartTitle">
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="revChartTitle">
                    12-month revenue
                  </h2>
                  <p className="card-sub">Expected revenue, Turkish lira.</p>
                </div>
              </div>
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={sections.revenue.months} margin={{ top: 20, right: 20, bottom: 10, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                    <XAxis
                      dataKey="month"
                      tickFormatter={formatMonthShort}
                      tick={{ fontSize: 11, fill: '#475569' }}
                      interval="preserveStartEnd"
                      minTickGap={20}
                    />
                    <YAxis
                      tick={{ fontSize: 11, fill: '#475569' }}
                      tickFormatter={(value) => `₺${(value / 1_000_000).toFixed(0)}M`}
                    />
                    <Tooltip formatter={(value) => [fmtTRYMillions(value), 'Expected revenue']} labelFormatter={formatMonthLong} />
                    <Bar dataKey="total_mid" name="Expected revenue" radius={[3, 3, 0, 0]} fill="#0b5c8f" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </section>
          )}

          {sections.users && (
            <section className="card" aria-labelledby="eventsTitle">
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="eventsTitle">
                    Recent activity
                  </h2>
                  <p className="card-sub">5 most recent audit events.</p>
                </div>
                <Link to="/activity-log" className="btn">
                  View all
                </Link>
              </div>
              {sections.users.recent_events.length === 0 ? (
                <p className="field-hint" style={{ padding: '0 20px' }}>No activity recorded yet.</p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: '0 20px' }}>
                  {sections.users.recent_events.map((e, i) => (
                    <li
                      key={i}
                      style={{
                        padding: '8px 0',
                        borderBottom: i < sections.users.recent_events.length - 1 ? '1px solid var(--border)' : 'none',
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{e.label}</span>
                      {' — '}
                      {e.actor_name || 'Unknown'} · {formatDateTime(e.time)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}
    </AppLayout>
  );
}

export default Overview;
