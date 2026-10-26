import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import InfoTip from './components/InfoTip';
import {
  UpTriangleIcon,
  DownTriangleIcon,
  DropOutlineIcon,
  LightbulbIcon,
  DownloadIcon,
  RetryIcon,
  ErrorTriangleIcon,
} from './layout/icons';
import {
  formatMonthShort,
  formatMonthShortYY,
  formatMonthLong,
  formatPublishedDate,
  monthsBetweenInclusive,
  shiftMonths,
  fmtInt,
  fmtMillions,
  fmtPercentChange,
} from './utils/format';
import { useViewportWidth } from './utils/useViewportWidth';
import './App.css';

const SHOW_NEXT_OPTIONS = [3, 6, 12];
const HISTORY_MONTHS_SHOWN = 36;
const API_URL = '/api/forecast/published';

// The model is evaluated on a fixed, 26-month held-out test split (102
// training / 26 test months, documented in README.md) — not something the
// published-forecast API returns per request, since it never changes
// between publishes of the same model.
const TEST_MONTHS = 26;

function ShowNextControl({ value, onChange }) {
  const refs = useRef({});

  const handleKeyDown = (e, idx) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const nextIdx = (idx + (e.key === 'ArrowRight' ? 1 : -1) + SHOW_NEXT_OPTIONS.length) % SHOW_NEXT_OPTIONS.length;
    const nextVal = SHOW_NEXT_OPTIONS[nextIdx];
    onChange(nextVal);
    refs.current[nextVal]?.focus();
  };

  return (
    <div className="ctl-group">
      <span className="ctl-label" id="horizonLabel">
        Show next
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby="horizonLabel">
        {SHOW_NEXT_OPTIONS.map((opt, idx) => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === opt}
            tabIndex={value === opt ? 0 : -1}
            ref={(el) => {
              refs.current[opt] = el;
            }}
            onClick={() => onChange(opt)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            {opt} months
          </button>
        ))}
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange, children }) {
  return (
    <button type="button" className="toggle" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span className="switch" aria-hidden="true" />
      {children}
    </button>
  );
}

function ForecastChartTooltip({ active, payload, label, showBand }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const point = payload[0].payload;
  const isForecast = point.yhat !== undefined && point.actual === undefined;

  return (
    <div className="chart-tooltip" role="group" aria-label={`${formatMonthLong(label)} details`}>
      <p className="chart-tooltip-label">
        {formatMonthLong(label)} {isForecast ? '· Forecast' : point.actual !== undefined ? '· Actual' : ''}
      </p>
      {point.actual !== undefined && <p>Actual: {fmtInt(point.actual)} m³</p>}
      {isForecast && point.yhat !== undefined && <p>Forecast: {fmtInt(point.yhat)} m³</p>}
      {showBand && Array.isArray(point.range) && (
        <p>
          80% range: {fmtInt(point.range[0])} – {fmtInt(point.range[1])} m³
        </p>
      )}
      {point.lastYear !== undefined && <p>Same month last year: {fmtInt(point.lastYear)} m³</p>}
    </div>
  );
}

function exportCsv(rows, showNext) {
  const header = ['Month', 'Forecast (m3)', 'Low (m3)', 'High (m3)', 'Same month last year (m3)', 'Change (%)'];
  const lines = [header.join(',')].concat(
    rows.map((r) =>
      [
        r.monthLabel,
        Math.round(r.yhat),
        Math.round(r.low),
        Math.round(r.high),
        r.lastYear != null ? Math.round(r.lastYear) : '',
        r.changePct != null ? r.changePct.toFixed(1) : '',
      ].join(',')
    )
  );
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `izmir-demand-forecast-${showNext}m.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Dashboard() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const hasForecastView = useMemo(() => Boolean(session?.permissions?.includes('forecast:view')), [session]);

  const [status, setStatus] = useState('loading'); // loading | ready | empty | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [data, setData] = useState(null);

  const [showNext, setShowNext] = useState(6);
  const [showBand, setShowBand] = useState(true);
  const [showLastYear, setShowLastYear] = useState(false);
  const viewportWidth = useViewportWidth();
  const narrowChart = viewportWidth < 600;

  const fetchForecast = useCallback(async () => {
    setStatus('loading');
    try {
      const response = await apiFetch(API_URL);

      if (response.status === 401) {
        clearSession();
        navigate('/login', {
          replace: true,
          state: { message: 'Your session has expired. Please sign in again.' },
        });
        return;
      }

      if (response.status === 403) {
        setStatus('forbidden');
        return;
      }

      if (response.status === 404) {
        setStatus('empty');
        return;
      }

      const body = await response.json();

      if (!response.ok) {
        setErrorReference(body.reference || null);
        setStatus('error');
        return;
      }

      setData(body);
      setStatus('ready');
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
    }
  }, [navigate, clearSession]);

  useEffect(() => {
    if (sessionLoading || !session || !hasForecastView) return;
    fetchForecast();
  }, [sessionLoading, session, hasForecastView, fetchForecast]);

  const computed = useMemo(() => {
    if (!data) return null;

    const history = data.history; // ascending, full series
    const forecastAll = data.forecast; // ascending, 12 months
    const historyMap = new Map(history.map((h) => [h.date, h.actual]));
    const visibleForecast = forecastAll.slice(0, showNext);

    // --- Chart dataset: last 36 actual months + the connector point (the
    // last actual value, repeated so the forecast/band lines visually
    // continue from it with no gap) + the visible forecast months. ---
    const historyShown = history.slice(-HISTORY_MONTHS_SHOWN);
    const chartRows = historyShown.map((h) => ({ date: h.date, actual: h.actual }));
    if (chartRows.length > 0) {
      chartRows[chartRows.length - 1].yhat = chartRows[chartRows.length - 1].actual;
    }
    visibleForecast.forEach((f) => {
      chartRows.push({
        date: f.date,
        yhat: f.yhat,
        // Recharts accepts a 2-element array as an Area's value — this
        // draws the 80% band as a single ranged area instead of stacking
        // two separate Area series.
        range: [f.yhat_lower, f.yhat_upper],
        lastYear: historyMap.get(shiftMonths(f.date, -12)),
      });
    });

    const allValues = chartRows.flatMap((r) => {
      const vals = [];
      if (r.actual !== undefined) vals.push(r.actual);
      if (r.yhat !== undefined) vals.push(r.yhat);
      if (showBand && Array.isArray(r.range)) vals.push(r.range[0], r.range[1]);
      if (showLastYear && r.lastYear !== undefined) vals.push(r.lastYear);
      return vals;
    });
    const minVal = allValues.length > 0 ? Math.min(...allValues) : 0;
    const maxVal = allValues.length > 0 ? Math.max(...allValues) : 0;
    const yDomainMin = minVal > 0 ? Math.floor((minVal * 0.92) / 1_000_000) * 1_000_000 : 0;
    const yDomainMax = maxVal > 0 ? Math.ceil((maxVal * 1.05) / 1_000_000) * 1_000_000 : undefined;
    const xTickInterval = Math.max(1, Math.floor(chartRows.length / 8));

    const forecastStartDate = visibleForecast[0]?.date;
    const forecastEndDate = visibleForecast[visibleForecast.length - 1]?.date;

    // --- KPIs: always based on the FIRST forecast month overall, not
    // affected by the "show next" filter. ---
    const firstForecast = forecastAll[0];
    const sameMonthLastYearDate = shiftMonths(firstForecast.date, -12);
    const sameMonthLastYearActual = historyMap.get(sameMonthLastYearDate);
    const vsChangePct =
      sameMonthLastYearActual != null
        ? ((firstForecast.yhat - sameMonthLastYearActual) / sameMonthLastYearActual) * 100
        : null;
    const lossRate = data.loss_rate;
    const recommendedProduction = lossRate != null ? firstForecast.yhat / (1 - lossRate) : null;

    // --- Insight: lowest/highest month within the CURRENTLY SHOWN window. ---
    let lowIdx = 0;
    let highIdx = 0;
    visibleForecast.forEach((f, i) => {
      if (f.yhat < visibleForecast[lowIdx].yhat) lowIdx = i;
      if (f.yhat > visibleForecast[highIdx].yhat) highIdx = i;
    });
    const lowMonth = visibleForecast[lowIdx];
    const highMonth = visibleForecast[highIdx];
    const insightPct = Math.round(((highMonth.yhat - lowMonth.yhat) / lowMonth.yhat) * 100);
    const insightRising = highIdx > lowIdx;

    // --- Table rows: exactly the visible window. ---
    const tableRows = visibleForecast.map((f) => {
      const lastYearVal = historyMap.get(shiftMonths(f.date, -12));
      const changePct = lastYearVal != null ? ((f.yhat - lastYearVal) / lastYearVal) * 100 : null;
      return {
        date: f.date,
        monthLabel: formatMonthShort(f.date),
        yhat: f.yhat,
        low: f.yhat_lower,
        high: f.yhat_upper,
        lastYear: lastYearVal,
        changePct,
      };
    });

    const trainedMonths = monthsBetweenInclusive(data.train_start, data.train_end);

    return {
      chartRows,
      yDomainMin,
      yDomainMax,
      xTickInterval,
      forecastStartDate,
      forecastEndDate,
      firstForecast,
      sameMonthLastYearDate,
      sameMonthLastYearActual,
      vsChangePct,
      recommendedProduction,
      lowMonth,
      highMonth,
      insightPct,
      insightRising,
      tableRows,
      trainedMonths,
    };
  }, [data, showNext, showBand, showLastYear]);

  const subtitle = 'Monthly billed water demand, İzmir';
  const extraLines =
    status === 'ready' && data && computed ? (
      <>
        <p className="published">
          <span className="dot" aria-hidden="true" />
          <span>
            Forecast published <b>{formatPublishedDate(data.published_at)}</b> · model trained on{' '}
            {formatMonthShort(data.train_start)} – {formatMonthShort(data.train_end)}
          </span>
        </p>
        <p className="published data-line">
          <span className="dot" aria-hidden="true" />
          <span>
            Latest available data: <b>{formatMonthLong(data.data_up_to)}</b> · forecasting from there
          </span>
        </p>
      </>
    ) : null;

  return (
    <AppLayout title="Demand Forecast" subtitle={subtitle} extraLines={extraLines} requiredPermission="forecast:view">
      {status === 'loading' && (
        <>
          <div className="state-banner" role="status" aria-live="polite">
            <span className="state-banner-spinner" aria-hidden="true" />
            <div>Loading forecast…</div>
          </div>
          <section className="kpis" aria-hidden="true">
            {[55, 45, 60, 65].map((w, i) => (
              <div className="card sk-kpi" key={i}>
                <div className="sk" style={{ width: `${w}%`, height: 12 }} />
                <div className="sk" style={{ width: '60%', height: 28 }} />
                <div className="sk" style={{ width: '80%', height: 10 }} />
              </div>
            ))}
          </section>
          <div className="sk" style={{ height: 58, borderRadius: 10 }} aria-hidden="true" />
          <div className="card sk-chart" aria-hidden="true">
            <div className="sk" style={{ width: '30%', height: 14 }} />
            <div className="sk" style={{ width: '55%', height: 30 }} />
            <div className="sk" style={{ flex: 1 }} />
          </div>
        </>
      )}

      {status === 'empty' && (
        <section className="card error-card" role="status">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>No forecast has been published yet.</h2>
          <p>Ask your administrator to publish one.</p>
        </section>
      )}

      {status === 'forbidden' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>You don't have permission to view the forecast.</h2>
        </section>
      )}

      {status === 'error' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>The forecast couldn't be loaded.</h2>
          <p>
            Try again in a moment.
            {errorReference
              ? ` If it keeps happening, tell your system administrator (reference ${errorReference}).`
              : ' If it keeps happening, tell your system administrator.'}
          </p>
          <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} onClick={fetchForecast}>
            <RetryIcon />
            Retry
          </button>
        </section>
      )}

      {status === 'ready' && data && computed && (
        <>
          <section className="kpis" aria-label="Key figures">
            <article className="card kpi accent">
              <div className="kpi-label">First forecast month: {formatMonthShort(computed.firstForecast.date)}</div>
              <div className="kpi-value">
                {fmtMillions(computed.firstForecast.yhat)}
                <span className="unit">M m³</span>
              </div>
              <div className="kpi-help">
                80% range {fmtMillions(computed.firstForecast.yhat_lower)}M – {fmtMillions(computed.firstForecast.yhat_upper)}M m³
              </div>
            </article>

            <article className="card kpi">
              <div className="kpi-label">vs {formatMonthShort(computed.sameMonthLastYearDate)}</div>
              {computed.vsChangePct !== null ? (
                <>
                  <div className={`kpi-value ${computed.vsChangePct >= 0 ? 'delta-up' : 'delta-down'}`}>
                    {computed.vsChangePct >= 0 ? <UpTriangleIcon /> : <DownTriangleIcon />}
                    <span>
                      <span className="sr-only">{computed.vsChangePct >= 0 ? 'Up ' : 'Down '}</span>
                      {fmtPercentChange(computed.vsChangePct)}
                      <span className="unit">%</span>
                    </span>
                  </div>
                  <div className="kpi-help">
                    <span className={`delta-pill${computed.vsChangePct >= 0 ? '' : ' down'}`}>
                      {computed.vsChangePct >= 0 ? 'Higher' : 'Lower'}
                    </span>{' '}
                    than {fmtMillions(computed.sameMonthLastYearActual)}M m³ last year
                  </div>
                </>
              ) : (
                <div className="kpi-value">—</div>
              )}
            </article>

            <article className="card kpi">
              <div className="kpi-label">
                Forecast accuracy
                <InfoTip id="tipAcc" label="How is accuracy measured?" align="right">
                  Measured as MAPE (mean absolute percentage error) on the test period Jul 2022 – Aug 2024.
                </InfoTip>
              </div>
              <div className="kpi-value">
                ±{Number(data.metrics.mape).toFixed(1)}
                <span className="unit">%</span>
              </div>
              <div className="kpi-help">average error on {TEST_MONTHS} months the model never saw</div>
            </article>

            <article className="card kpi">
              <div className="kpi-label">
                Recommended production
                <InfoTip id="tipProd" label="How is this calculated?" align="right">
                  <b>How is this calculated?</b>
                  <br />
                  Forecast ÷ (1 − {data.loss_rate != null ? data.loss_rate.toFixed(3) : '?'}).
                  <br />
                  Source: {data.loss_rate_source || 'not available'}.
                </InfoTip>
              </div>
              {computed.recommendedProduction !== null ? (
                <>
                  <div className="kpi-value">
                    {fmtMillions(computed.recommendedProduction)}
                    <span className="unit">M m³</span>
                  </div>
                  <div className="kpi-help">
                    includes a {(data.loss_rate * 100).toFixed(1)}% allowance for non-revenue water
                  </div>
                </>
              ) : (
                <div className="kpi-value">—</div>
              )}
            </article>
          </section>

          <section className="summary" aria-label="Summary">
            <span className="summary-icon" aria-hidden="true">
              <DropOutlineIcon />
            </span>
            <p>
              Demand for <b>{formatMonthLong(computed.firstForecast.date)}</b> is expected to be{' '}
              <b>{fmtMillions(computed.firstForecast.yhat)}M m³</b> (likely between{' '}
              {fmtMillions(computed.firstForecast.yhat_lower)}M and {fmtMillions(computed.firstForecast.yhat_upper)}M),{' '}
              {computed.vsChangePct !== null ? (
                <>
                  about <b>
                    {fmtPercentChange(computed.vsChangePct)}% {computed.vsChangePct >= 0 ? 'higher' : 'lower'}
                  </b>{' '}
                  than {formatMonthShort(computed.sameMonthLastYearDate)}.
                </>
              ) : (
                'no comparable month last year is available.'
              )}
            </p>
          </section>

          <p className="insight" aria-live="polite">
            <LightbulbIcon />
            <span>
              <b>Insight:</b>{' '}
              {computed.insightRising
                ? `demand is expected to rise about ${computed.insightPct}% from ${formatMonthShort(
                    computed.lowMonth.date
                  )} to ${formatMonthShort(computed.highMonth.date)} — plan summer production early.`
                : `demand is expected to fall through the coming months, reaching its low in ${formatMonthShort(
                    computed.lowMonth.date
                  )}.`}
            </span>
          </p>

          <section className="card" aria-labelledby="chartTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="chartTitle">
                  Actual and forecast demand
                </h2>
                <p className="card-sub">
                  Last {HISTORY_MONTHS_SHOWN} months actual · next {showNext} months forecast · millions of m³
                </p>
              </div>
            </div>
            <div className="controls" role="group" aria-label="Chart options">
              <ShowNextControl value={showNext} onChange={setShowNext} />
              <div className="ctl-group">
                <ToggleSwitch checked={showBand} onChange={setShowBand}>
                  Show 80% range
                </ToggleSwitch>
                <InfoTip id="tipBand" label="What is the 80% range?">
                  8 out of 10 times, actual demand should fall inside this band
                </InfoTip>
              </div>
              <div className="ctl-group">
                <ToggleSwitch checked={showLastYear} onChange={setShowLastYear}>
                  Show same months last year
                </ToggleSwitch>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={computed.chartRows} margin={{ top: 30, right: 20, bottom: 10, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={narrowChart ? formatMonthShortYY : formatMonthShort}
                    tick={{ fontSize: 11, fill: '#475569' }}
                    interval={narrowChart ? 'preserveStartEnd' : computed.xTickInterval}
                    minTickGap={narrowChart ? 30 : 20}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#475569' }}
                    tickFormatter={(value) => `${(value / 1_000_000).toFixed(0)}M`}
                    domain={[computed.yDomainMin, computed.yDomainMax]}
                    allowDataOverflow
                    label={{
                      value: 'Demand (million m³)',
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 11, textAnchor: 'middle', fill: '#475569' },
                    }}
                  />
                  <Tooltip content={<ForecastChartTooltip showBand={showBand} />} />
                  {computed.forecastStartDate && computed.forecastEndDate && (
                    <ReferenceArea
                      x1={computed.forecastStartDate}
                      x2={computed.forecastEndDate}
                      fill="#0d7f80"
                      fillOpacity={0.045}
                      stroke="none"
                    />
                  )}
                  {computed.forecastStartDate && (
                    <ReferenceLine
                      x={computed.forecastStartDate}
                      stroke="#475569"
                      strokeDasharray="4 4"
                      label={{ value: 'Forecast starts', position: 'insideTopRight', fontSize: 11, fill: '#0f2537' }}
                    />
                  )}
                  {showBand && (
                    <Area
                      type="monotone"
                      dataKey="range"
                      stroke="#0d7f80"
                      strokeOpacity={0.3}
                      strokeWidth={1}
                      fill="#0d7f80"
                      fillOpacity={0.15}
                      connectNulls
                      name="80% range"
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="actual"
                    stroke="#0b5c8f"
                    strokeWidth={2.5}
                    dot={false}
                    name="Actual"
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="yhat"
                    stroke="#0d7f80"
                    strokeWidth={2.5}
                    strokeDasharray="7 5"
                    dot={{ r: 3, fill: '#fff', stroke: '#0d7f80', strokeWidth: 2 }}
                    name="Forecast"
                    connectNulls
                  />
                  {showLastYear && (
                    <Line
                      type="monotone"
                      dataKey="lastYear"
                      stroke="#64748b"
                      strokeWidth={2}
                      strokeDasharray="2 4"
                      dot={{ r: 2.5 }}
                      name="Same month last year"
                      connectNulls
                    />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="legend" aria-hidden="true">
              <span>
                <i className="lg-line" />
                Actual
              </span>
              <span>
                <i className="lg-dash" />
                Forecast
              </span>
              <span className={showBand ? '' : 'off'}>
                <i className="lg-band" />
                80% range
              </span>
              <span className={showLastYear ? '' : 'off'}>
                <i className="lg-dot" />
                Same months last year
              </span>
            </div>
          </section>

          <section className="card" aria-labelledby="tableTitle">
            <div className="card-head" style={{ paddingBottom: 6 }}>
              <div>
                <h2 className="card-title" id="tableTitle">
                  Monthly forecast
                </h2>
                <p className="card-sub">Next {showNext} months · values in m³</p>
              </div>
              <button className="btn" type="button" onClick={() => exportCsv(computed.tableRows, showNext)}>
                <DownloadIcon />
                Export CSV
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">
                  Monthly forecast with 80% range and comparison to the same month last year
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    <th scope="col">Forecast (m³)</th>
                    <th scope="col">Low (m³)</th>
                    <th scope="col">High (m³)</th>
                    <th scope="col">Same month last year (m³)</th>
                    <th scope="col">Change (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {computed.tableRows.map((r) => {
                    const up = r.changePct !== null && r.changePct >= 0;
                    return (
                      <tr key={r.date}>
                        <td className="month">{r.monthLabel}</td>
                        <td>
                          <b>{fmtInt(r.yhat)}</b>
                        </td>
                        <td className="muted">{fmtInt(r.low)}</td>
                        <td className="muted">{fmtInt(r.high)}</td>
                        <td>{r.lastYear != null ? fmtInt(r.lastYear) : '—'}</td>
                        <td className={r.changePct === null ? 'muted' : up ? 'chg-up' : 'chg-down'}>
                          {r.changePct !== null ? (
                            <>
                              <span aria-hidden="true">{up ? '▲' : '▼'}</span>
                              <span className="sr-only">{up ? 'up' : 'down'}</span> {Math.abs(r.changePct).toFixed(1)}%
                            </>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="table-note">
              Low and High are the 80% range. Change compares the forecast with actual billed demand in the same
              month one year earlier.
            </div>
          </section>

          <footer className="foot">
            <div className="foot-line">
              <span>
                Model: {data.model_name} · trained on {formatMonthShort(data.train_start)} –{' '}
                {formatMonthShort(data.train_end)} ({computed.trainedMonths} months)
              </span>
              <InfoTip id="tipModel" label="About the model">
                Prophet learns the long-term trend and the yearly summer/winter pattern from past billed demand.
                Accuracy was checked on {TEST_MONTHS} months the model did not see during training.
              </InfoTip>
            </div>
          </footer>
        </>
      )}
    </AppLayout>
  );
}

export default Dashboard;
