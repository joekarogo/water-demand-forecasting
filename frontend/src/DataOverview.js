import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import { RetryIcon, ErrorTriangleIcon, EmptyForecastIcon } from './layout/icons';
import { formatMonthShort, formatMonthLong, fmtInt } from './utils/format';
import './App.css';

const API_URL = '/api/consumption-history';

// Ticks only January of each year (extracted straight from the "YYYY-MM-DD"
// string, no Date parsing needed) — every other month renders an empty
// label, so the axis reads as yearly markers across ~128 months without
// Recharts auto-skipping ticks unpredictably.
function yearOnlyTick(dateStr) {
  return dateStr.slice(5, 7) === '01' ? dateStr.slice(0, 4) : '';
}

function HistoryChartTooltip({ active, payload }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const point = payload[0].payload;
  return (
    <div className="chart-tooltip" role="group" aria-label={`${formatMonthLong(point.date)} details`}>
      <p className="chart-tooltip-label">{formatMonthLong(point.date)}</p>
      <p>{fmtInt(point.consumption_m3)} m³</p>
    </div>
  );
}

function DataOverview() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const hasDataView = useMemo(() => Boolean(session?.permissions?.includes('data:view')), [session]);

  const [status, setStatus] = useState('loading'); // loading | ready | empty | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [history, setHistory] = useState([]);

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

  const fetchHistory = useCallback(async () => {
    setStatus('loading');
    try {
      const response = await apiFetch(API_URL);
      if (handleAuthError(response)) return;
      if (response.status === 403) {
        setStatus('forbidden');
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setErrorReference(body.reference || null);
        setStatus('error');
        return;
      }
      setHistory(body.data || []);
      setStatus((body.data || []).length === 0 ? 'empty' : 'ready');
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
    }
  }, [handleAuthError]);

  useEffect(() => {
    if (sessionLoading || !session || !hasDataView) return;
    fetchHistory();
  }, [sessionLoading, session, hasDataView, fetchHistory]);

  const computed = useMemo(() => {
    if (history.length === 0) return null;
    const totalRecords = history.length;
    const avgConsumption = history.reduce((sum, row) => sum + row.consumption_m3, 0) / totalRecords;
    const peakRow = history.reduce((max, row) => (row.consumption_m3 > max.consumption_m3 ? row : max), history[0]);
    const firstMonthLabel = formatMonthShort(history[0].date);
    const lastMonthLabel = formatMonthShort(history[totalRecords - 1].date);
    return { totalRecords, avgConsumption, peakRow, firstMonthLabel, lastMonthLabel };
  }, [history]);

  const subtitle = 'Monthly billed water consumption, İzmir';

  return (
    <AppLayout title="Historical Analysis" subtitle={subtitle} requiredPermission="data:view">
      {status === 'loading' && (
        <>
          <div className="state-banner" role="status" aria-live="polite">
            <span className="state-banner-spinner" aria-hidden="true" />
            <div>Loading historical data…</div>
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
          <div className="card sk-chart" aria-hidden="true">
            <div className="sk" style={{ width: '30%', height: 14 }} />
            <div className="sk" style={{ width: '55%', height: 30 }} />
            <div className="sk" style={{ flex: 1 }} />
          </div>
        </>
      )}

      {status === 'error' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>Historical data couldn't be loaded.</h2>
          <p>
            Try again in a moment.
            {errorReference
              ? ` If it keeps happening, tell your system administrator (reference ${errorReference}).`
              : ' If it keeps happening, tell your system administrator.'}
          </p>
          <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} onClick={fetchHistory}>
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
          <h2>You don't have permission to view historical data.</h2>
        </section>
      )}

      {status === 'empty' && (
        <section className="card error-card" role="status">
          <span className="empty-icon" aria-hidden="true">
            <EmptyForecastIcon />
          </span>
          <h2>No historical data available</h2>
          <p>Nothing has been recorded yet. Contact your system administrator if that's unexpected.</p>
        </section>
      )}

      {status === 'ready' && computed && (
        <>
          <section className="kpis" aria-label="Key figures">
            <article className="card kpi accent">
              <div className="kpi-label">Date range</div>
              <div className="kpi-value name">
                {computed.firstMonthLabel} – {computed.lastMonthLabel}
              </div>
            </article>

            <article className="card kpi">
              <div className="kpi-label">Months of data</div>
              <div className="kpi-value">{computed.totalRecords}</div>
            </article>

            <article className="card kpi">
              <div className="kpi-label">Average monthly demand</div>
              <div className="kpi-value">{fmtInt(computed.avgConsumption)}</div>
              <div className="kpi-help">m³</div>
            </article>

            <article className="card kpi">
              <div className="kpi-label">Peak month</div>
              <div className="kpi-value name">{formatMonthShort(computed.peakRow.date)}</div>
              <div className="kpi-help">{fmtInt(computed.peakRow.consumption_m3)} m³</div>
            </article>
          </section>

          <section className="card" aria-labelledby="historyChartTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="historyChartTitle">
                  Monthly billed water demand, {computed.firstMonthLabel} – {computed.lastMonthLabel}
                </h2>
                <p className="card-sub">Million m³ · hover or tap a month for the figures</p>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={yearOnlyTick}
                    tick={{ fontSize: 11, fill: '#475569' }}
                    interval={0}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#475569' }}
                    tickFormatter={(value) => `${(value / 1_000_000).toFixed(0)}M`}
                  />
                  <Tooltip content={<HistoryChartTooltip />} />
                  <Line type="monotone" dataKey="consumption_m3" stroke="#0b5c8f" strokeWidth={2} dot={false} name="Billed demand" />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="field-hint" style={{ padding: '0 20px 18px' }}>
              Five unusual months (the September 2019 billing spike, April–June and August 2020 during COVID) were
              smoothed before training; the chart shows the cleaned data.
            </p>
          </section>
        </>
      )}
    </AppLayout>
  );
}

export default DataOverview;
