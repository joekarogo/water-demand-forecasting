import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import InfoTip from './components/InfoTip';
import { RetryIcon, ErrorTriangleIcon, EmptyForecastIcon, DownloadIcon, InfoIcon, DropOutlineIcon } from './layout/icons';
import {
  formatMonthShort,
  formatMonthLong,
  formatPublishedDate,
  monthName,
  fmtInt,
  fmtMillions,
  formatDistrictName,
} from './utils/format';
import { downloadTextFile } from './utils/download';
import './App.css';

const API_URL = '/api/distribution';
const BARS_LIMIT = 10;
const PLAN_TYPE_LABELS = { normal: 'Normal', safe: 'Safe', custom: 'Custom' };

const COLUMNS = [
  { key: 'district', label: 'District' },
  { key: 'subscribers', label: 'Subscribers' },
  { key: 'share_pct', label: 'Share' },
  { key: 'forecast_m3', label: 'Forecast (m³)' },
  { key: 'lower_m3', label: 'Likely range (m³)' },
  { key: 'allocation_m3', label: 'Plan allocation (m³)' },
  { key: 'share_change_pts', label: 'Share vs last year' },
];

// "A, B and C" / "A and B" — used to list the top districts in the summary
// sentence without a trailing "and" when there are only two.
function listAnd(items) {
  if (items.length < 3) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function ToggleSwitch({ checked, onChange, children, controls }) {
  return (
    <button
      type="button"
      className="toggle"
      role="switch"
      aria-checked={checked}
      aria-controls={controls}
      onClick={() => onChange(!checked)}
    >
      <span className="switch" aria-hidden="true" />
      {children}
    </button>
  );
}

// Direction is carried by the ▲/▼ glyph (plus the sr-only word), not by
// colour — chg-up/chg-down both render in the same neutral text colour,
// same convention as StockChangeCell on Production Planning.
function ShareChangeCell({ pts }) {
  if (pts == null) {
    return <span className="chg-n">—</span>;
  }
  if (Math.abs(pts) < 0.05) {
    return <span className="chg-n">0.0 pts</span>;
  }
  const up = pts > 0;
  return (
    <span className={up ? 'chg-up' : 'chg-down'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      <span className="sr-only">{up ? 'up' : 'down'}</span> {up ? '+' : '−'}
      {Math.abs(pts).toFixed(1)} pts
    </span>
  );
}

function DemandByDistrict() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const hasDistributionView = useMemo(() => Boolean(session?.permissions?.includes('distribution:view')), [session]);

  const [status, setStatus] = useState('loading'); // loading | ready | empty | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [data, setData] = useState(null);

  const [monthIndex, setMonthIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState('forecast_m3');
  const [sortDir, setSortDir] = useState('desc');

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
      if (response.status === 403) {
        setStatus('forbidden');
        return;
      }
      if (response.status === 404) {
        setStatus('empty');
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrorReference(body.reference || null);
        setStatus('error');
        return;
      }
      setData(body);
      setMonthIndex(0);
      setStatus('ready');
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
    }
  }, [handleAuthError]);

  useEffect(() => {
    if (sessionLoading || !session || !hasDistributionView) return;
    fetchData();
  }, [sessionLoading, session, hasDistributionView, fetchData]);

  const months = data?.months || [];
  const month = months[monthIndex] || null;
  const rows = useMemo(() => month?.districts || [], [month]);

  const byForecastDesc = useMemo(() => [...rows].sort((a, b) => b.forecast_m3 - a.forecast_m3), [rows]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      let x = a[sortKey];
      let y = b[sortKey];
      if (sortKey === 'district') {
        return sortDir === 'asc' ? x.localeCompare(y) : y.localeCompare(x);
      }
      if (x == null) x = -Infinity;
      if (y == null) y = -Infinity;
      return sortDir === 'asc' ? x - y : y - x;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const totals = useMemo(() => {
    if (rows.length === 0) return null;
    return {
      subscribers: rows.reduce((sum, r) => sum + (r.subscribers || 0), 0),
      forecast_m3: rows.reduce((sum, r) => sum + r.forecast_m3, 0),
      lower_m3: rows.reduce((sum, r) => sum + r.lower_m3, 0),
      upper_m3: rows.reduce((sum, r) => sum + r.upper_m3, 0),
      allocation_m3: month?.plan_chosen_m3 ?? null,
    };
  }, [rows, month]);

  const monthShortLabel = month ? formatMonthShort(month.month).split(' ')[0] : '';
  const changeHeading = month?.change_years
    ? `Share change, ${monthShortLabel} ${month.change_years[0]} vs ${monthShortLabel} ${month.change_years[1]} (pts)`
    : 'Share change (pts)';

  const shareYearRange = useMemo(() => {
    if (!month?.share_years || month.share_years.length === 0) return '';
    const sorted = [...month.share_years].sort((a, b) => a - b);
    return sorted.length === 1 ? `${sorted[0]}` : `${sorted[0]}–${sorted[sorted.length - 1]}`;
  }, [month]);

  const lossPct = data?.loss_rate != null ? (data.loss_rate * 100).toFixed(1) : null;

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'district' ? 'asc' : 'desc');
    }
  };

  const handleExportCsv = () => {
    if (!month) return;
    const head = [
      'District',
      'Subscribers',
      'Share (%)',
      'Forecast billed (m3)',
      'Low (m3)',
      'High (m3)',
      'Plan allocation (m3)',
      changeHeading,
    ];
    const lines = [head.join(',')].concat(
      sortedRows.map((r) =>
        [
          `"${formatDistrictName(r.district)}"`,
          r.subscribers ?? '',
          r.share_pct.toFixed(1),
          Math.round(r.forecast_m3),
          Math.round(r.lower_m3),
          Math.round(r.upper_m3),
          r.allocation_m3 == null ? '' : Math.round(r.allocation_m3),
          r.share_change_pts == null ? '' : r.share_change_pts.toFixed(1),
        ].join(',')
      )
    );
    downloadTextFile(`district-demand-${month.month}.csv`, lines.join('\n'));
  };

  const subtitle = 'Which districts need the most water in a given month?';

  return (
    <AppLayout title="Demand by district" subtitle={subtitle} requiredPermission="distribution:view">
      {status === 'loading' && (
        <>
          <div className="state-banner" role="status" aria-live="polite">
            <span className="state-banner-spinner" aria-hidden="true" />
            <div>Loading district demand…</div>
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
          <div className="card sk-table" aria-hidden="true">
            <div className="sk" style={{ width: '30%', height: 14 }} />
            <div className="sk" style={{ width: '40%', height: 28 }} />
            <div className="sk" style={{ height: 70 }} />
            {[1, 2, 3, 4, 5].map((n) => (
              <div className="sk" style={{ height: 16 }} key={n} />
            ))}
          </div>
        </>
      )}

      {status === 'error' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>District demand couldn't be loaded.</h2>
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

      {status === 'forbidden' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>You don't have permission to view demand by district.</h2>
        </section>
      )}

      {status === 'empty' && (
        <section className="card error-card" role="status">
          <span className="empty-icon" aria-hidden="true">
            <EmptyForecastIcon />
          </span>
          <h2>No forecast published</h2>
          <p>
            District demand is calculated from the published city forecast, and none has been published yet. Ask
            your administrator to publish one.
          </p>
        </section>
      )}

      {status === 'ready' && data && month && (
        <>
          <section className="card month-bar" aria-label="Choose a month">
            <label htmlFor="monthSel">Month</label>
            <div className="month-ctl">
              <button
                type="button"
                className="step-btn"
                aria-label="Previous month"
                disabled={monthIndex === 0}
                onClick={() => setMonthIndex((i) => Math.max(0, i - 1))}
              >
                ‹
              </button>
              <select
                className="input"
                id="monthSel"
                aria-describedby="monthHint"
                value={monthIndex}
                onChange={(e) => setMonthIndex(Number(e.target.value))}
              >
                {months.map((m, i) => (
                  <option key={m.month} value={i}>
                    {formatMonthShort(m.month)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="step-btn"
                aria-label="Next month"
                disabled={monthIndex === months.length - 1}
                onClick={() => setMonthIndex((i) => Math.min(months.length - 1, i + 1))}
              >
                ›
              </button>
            </div>
            <span className="month-hint" id="monthHint">
              Published forecast months: {formatMonthShort(months[0].month)} – {formatMonthShort(months[months.length - 1].month)}
            </span>
          </section>

          <p className="published">
            <span className="dot" aria-hidden="true" style={{ background: '#94a3b8' }} />
            <span>
              Districts are administrative areas, not water supply zones; figures show expected billed demand, not
              pipe routing.
            </span>
            <InfoTip id="tipMethod" label="How are district figures estimated?">
              <b>How are district figures estimated?</b>
              <br />
              District forecast = city forecast for that month × the district's average share of the same calendar
              month over the last 3 years with data.
              <br />
              The likely range reflects city forecast uncertainty only; the district split adds further error on
              top of that.
              {lossPct != null && (
                <>
                  <br />
                  One loss rate ({lossPct}%) is applied to all districts; real losses vary by district.
                </>
              )}
            </InfoTip>
          </p>

          <section className="kpis" aria-label="Key figures">
            <article className="card kpi accent">
              <div className="kpi-label">Largest district</div>
              <div className="kpi-value name">{formatDistrictName(byForecastDesc[0].district)}</div>
              <div className="kpi-help">
                {byForecastDesc[0].share_pct.toFixed(1)}% of the city · {fmtMillions(byForecastDesc[0].forecast_m3)}M m³
              </div>
            </article>
            <article className="card kpi">
              <div className="kpi-label">Districts covered</div>
              <div className="kpi-value">{data.districts.length}</div>
              <div className="kpi-help">districts with consumption data</div>
            </article>
            <article className="card kpi">
              <div className="kpi-label">Biggest seasonal swing</div>
              {data.swing ? (
                <>
                  <div className="kpi-value name">{formatDistrictName(data.swing.district)}</div>
                  <div className="kpi-help">
                    about {data.swing.ratio.toFixed(1)}× more in {monthName(data.swing.highMonth)} than{' '}
                    {monthName(data.swing.lowMonth)}
                  </div>
                </>
              ) : (
                <>
                  <div className="kpi-value">—</div>
                  <div className="kpi-help">Not enough historical data yet</div>
                </>
              )}
            </article>
            <article className="card kpi">
              <div className="kpi-label">Production plan for this month</div>
              {month.plan_chosen_m3 != null ? (
                <>
                  <div className="kpi-value">
                    {fmtMillions(month.plan_chosen_m3)}
                    <span className="unit">M m³</span>
                  </div>
                  <div className="kpi-help">
                    {PLAN_TYPE_LABELS[month.plan_type] || month.plan_type}
                    {lossPct != null ? ` plan · includes the ${lossPct}% loss allowance` : ' plan'}
                  </div>
                </>
              ) : (
                <>
                  <div className="kpi-value muted-val">No plan saved</div>
                  <div className="kpi-help">
                    <button type="button" className="kpi-link" onClick={() => navigate('/production-planning')}>
                      Go to Production Planning
                    </button>
                  </div>
                </>
              )}
            </article>
          </section>

          <section className="summary" aria-label="Summary" aria-live="polite">
            <span className="summary-icon" aria-hidden="true">
              <DropOutlineIcon />
            </span>
            <p>
              In <b>{formatMonthLong(month.month)}</b>,{' '}
              <b>{listAnd(byForecastDesc.slice(0, 3).map((r) => formatDistrictName(r.district)))}</b> need the most water.
            </p>
          </section>

          <section className="card" aria-labelledby="barsTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="barsTitle">
                  Expected billed demand by district
                </h2>
                <p className="card-sub">
                  {formatMonthLong(month.month)} ·{' '}
                  {showAll
                    ? `all ${data.districts.length} districts`
                    : `top ${Math.min(BARS_LIMIT, data.districts.length)} of ${data.districts.length}`}
                  , largest first
                </p>
              </div>
              <ToggleSwitch checked={showAll} onChange={setShowAll} controls="bars">
                Show all {data.districts.length}
              </ToggleSwitch>
            </div>
            <ol className="bars" id="bars">
              {(showAll ? byForecastDesc : byForecastDesc.slice(0, BARS_LIMIT)).map((r, i) => (
                <li className="bar-row" key={r.district}>
                  <span className="bar-rank" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="bar-name">{formatDistrictName(r.district)}</span>
                  <span className="bar-track" aria-hidden="true">
                    <span
                      className="bar-fill"
                      style={{ width: `${((r.forecast_m3 / byForecastDesc[0].forecast_m3) * 100).toFixed(1)}%` }}
                    />
                  </span>
                  <span className="bar-val">
                    {fmtMillions(r.forecast_m3)}M m³ <span>· {r.share_pct.toFixed(1)}%</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="bars-foot">
              Bars show forecast billed water in million m³; the percentage is the district's share of the city.
            </p>
          </section>

          <section className="card" aria-labelledby="tableTitle">
            <div className="card-head" style={{ paddingBottom: 6 }}>
              <div>
                <h2 className="card-title" id="tableTitle">
                  District table
                </h2>
                <p className="card-sub">
                  {formatMonthLong(month.month)} · all {data.districts.length} districts · values in m³
                </p>
              </div>
              <button className="btn" type="button" onClick={handleExportCsv}>
                <DownloadIcon />
                Export CSV
              </button>
            </div>
            {month.plan_chosen_m3 == null && (
              <div className="no-plan" role="note">
                <InfoIcon />
                <span>
                  No production plan saved for this month.{' '}
                  <button type="button" className="kpi-link" onClick={() => navigate('/production-planning')}>
                    Go to Production Planning
                  </button>
                  .
                </span>
              </div>
            )}
            <div className="table-wrap">
              <table className="district-table">
                <caption className="sr-only">
                  District demand for the selected month. Column headers are buttons that sort the table.
                </caption>
                <thead>
                  <tr>
                    {COLUMNS.map((c) => {
                      const active = sortKey === c.key;
                      const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
                      const icon = ariaSort === 'ascending' ? '▲' : ariaSort === 'descending' ? '▼' : '↕';
                      return (
                        <th key={c.key} scope="col" aria-sort={ariaSort} title={c.key === 'share_change_pts' ? changeHeading : undefined}>
                          <button type="button" className="sort-btn" onClick={() => handleSort(c.key)}>
                            {c.label}
                            <span className="sort-ic" aria-hidden="true">
                              {icon}
                            </span>
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((r) => (
                    <tr key={r.district}>
                      <th scope="row" style={{ textAlign: 'left', fontWeight: 600 }}>
                        {formatDistrictName(r.district)}
                      </th>
                      <td>{r.subscribers != null ? fmtInt(r.subscribers) : '—'}</td>
                      <td>{r.share_pct.toFixed(1)}%</td>
                      <td>
                        <b>{fmtInt(r.forecast_m3)}</b>
                      </td>
                      <td className="muted">
                        {fmtInt(r.lower_m3)} – {fmtInt(r.upper_m3)}
                      </td>
                      {r.allocation_m3 == null ? (
                        <td className="dash" aria-label="No plan saved">
                          —
                        </td>
                      ) : (
                        <td>{fmtInt(r.allocation_m3)}</td>
                      )}
                      <td>
                        <ShareChangeCell pts={r.share_change_pts} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr>
                      <th scope="row" style={{ textAlign: 'left' }}>
                        All {data.districts.length} districts
                      </th>
                      <td>{fmtInt(totals.subscribers)}</td>
                      <td>100%</td>
                      <td>{fmtInt(totals.forecast_m3)}</td>
                      <td>
                        {fmtInt(totals.lower_m3)} – {fmtInt(totals.upper_m3)}
                      </td>
                      <td>{totals.allocation_m3 != null ? fmtInt(totals.allocation_m3) : '—'}</td>
                      <td></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div className="table-note">
              Share is the district's average share of the same calendar month over the last three years. Plan
              allocation splits the saved production plan by share. Share vs last year compares the district's share
              in that month last year with the year before.
            </div>
          </section>

          <footer className="foot">
            <p className="prov">
              Shares from district consumption, <b>{monthName(Number(month.month.slice(5, 7)))} {shareYearRange}</b>{' '}
              · Forecast published <b>{formatPublishedDate(data.published_at)}</b>
              {lossPct != null && (
                <> · Billed water; production plan includes the {lossPct}% loss allowance.</>
              )}
            </p>
          </footer>
        </>
      )}
    </AppLayout>
  );
}

export default DemandByDistrict;
