import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
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
  fmtMillions,
  fmtPercentChange,
} from './utils/format';
import { useViewportWidth } from './utils/useViewportWidth';
import { downloadTextFile } from './utils/download';
import './App.css';

const API_URL = '/api/forecast/published';

// The model is evaluated on a fixed, 26-month held-out test split (102
// training / 26 test months, documented in README.md) — not something the
// published-forecast API returns per request, since it never changes
// between publishes of the same model.
const TEST_MONTHS = 26;

// Two-line "Mon / YYYY" tick on wide screens; falls back to the existing
// single-line "Mon YY" format on narrow screens, where a second line
// wouldn't leave enough vertical room to stay legible.
function ForecastXAxisTick({ x, y, payload, narrow }) {
  if (narrow) {
    return (
      <text x={x} y={y + 12} textAnchor="middle" fontSize={11} fill="#475569">
        {formatMonthShortYY(payload.value)}
      </text>
    );
  }
  const [monthAbbr, year] = formatMonthShort(payload.value).split(' ');
  return (
    <g>
      <text x={x} y={y + 12} textAnchor="middle" fontSize={11} fill="#475569">
        {monthAbbr}
      </text>
      <text x={x} y={y + 26} textAnchor="middle" fontSize={10} fill="#94a3b8">
        {year}
      </text>
    </g>
  );
}

// A small end-of-line text label, shown only at the last data point so the
// chart reads like the mockup's "Forecast" / "Last year" line labels
// instead of relying solely on the legend below. `dy` is passed per-line so
// the two labels never collide: the higher line's label sits above its
// point, the lower line's label sits below it.
function lastPointLabel(text, color, lastIndex, dy) {
  return (props) => {
    if (props.index !== lastIndex || props.value == null) return null;
    return (
      <text x={props.x + 8} y={props.y} dy={dy} fontSize={12} fontWeight={700} fill={color} textAnchor="start">
        {text}
      </text>
    );
  };
}

function ForecastChartTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const point = payload[0].payload;
  const changePct = point.lastYear != null ? ((point.yhat - point.lastYear) / point.lastYear) * 100 : null;
  const up = changePct !== null && changePct >= 0;

  return (
    <div className="chart-tooltip" role="group" aria-label={`${formatMonthLong(label)} details`}>
      <p className="chart-tooltip-label">{formatMonthLong(label)}</p>
      <p>Forecast: {fmtMillions(point.yhat, 2)}M m³</p>
      <p>Same month last year: {point.lastYear != null ? `${fmtMillions(point.lastYear, 2)}M m³` : '—'}</p>
      <p>
        Change:{' '}
        {changePct !== null ? (
          <>
            <span aria-hidden="true">{up ? '▲' : '▼'}</span> <span className="sr-only">{up ? 'up' : 'down'}</span>
            {fmtPercentChange(changePct)}%
          </>
        ) : (
          '—'
        )}
      </p>
      {Array.isArray(point.range) && (
        <p>
          Likely range: {fmtMillions(point.range[0], 1)}M – {fmtMillions(point.range[1], 1)}M
        </p>
      )}
    </div>
  );
}

function exportCsv(rows) {
  const header = ['month', 'forecast_m3', 'same_month_last_year_m3', 'change_pct', 'likely_low_m3', 'likely_high_m3'];
  const lines = [header.join(',')].concat(
    rows.map((r) =>
      [
        r.monthLabel,
        Math.round(r.yhat),
        r.lastYear != null ? Math.round(r.lastYear) : '',
        r.changePct != null ? r.changePct.toFixed(1) : '',
        Math.round(r.low),
        Math.round(r.high),
      ].join(',')
    )
  );
  downloadTextFile('izmir-demand-forecast.csv', lines.join('\n'));
}

function Dashboard() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const hasForecastView = useMemo(() => Boolean(session?.permissions?.includes('forecast:view')), [session]);

  const [status, setStatus] = useState('loading'); // loading | ready | empty | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [data, setData] = useState(null);

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
    const forecast = data.forecast; // ascending, 12 months
    const historyMap = new Map(history.map((h) => [h.date, h.actual]));

    // --- Chart dataset: the 12 forecast months only, no history. ---
    const chartRows = forecast.map((f) => ({
      date: f.date,
      yhat: f.yhat,
      // Recharts accepts a 2-element array as an Area's value — this draws
      // the likely range as a single ranged area instead of stacking two
      // separate Area series.
      range: [f.yhat_lower, f.yhat_upper],
      lastYear: historyMap.get(shiftMonths(f.date, -12)),
    }));

    const allValues = chartRows.flatMap((r) => {
      const vals = [r.yhat];
      if (Array.isArray(r.range)) vals.push(r.range[0], r.range[1]);
      if (r.lastYear != null) vals.push(r.lastYear);
      return vals;
    });
    const minVal = allValues.length > 0 ? Math.min(...allValues) : 0;
    const maxVal = allValues.length > 0 ? Math.max(...allValues) : 0;
    // Even 2M-wide domain/ticks, so axis labels read 15M/17M/19M/... instead
    // of an uneven step.
    const Y_TICK_STEP = 2_000_000;
    const yDomainMin = minVal > 0 ? Math.floor(minVal / Y_TICK_STEP) * Y_TICK_STEP : 0;
    const yDomainMax = maxVal > 0 ? Math.ceil(maxVal / Y_TICK_STEP) * Y_TICK_STEP : undefined;
    const yTicks = [];
    if (yDomainMax !== undefined) {
      for (let t = yDomainMin; t <= yDomainMax; t += Y_TICK_STEP) yTicks.push(t);
    }

    const lastRow = chartRows[chartRows.length - 1];
    const forecastIsHigherAtEnd =
      lastRow && lastRow.lastYear != null ? lastRow.yhat >= lastRow.lastYear : true;

    // --- KPIs: always based on the FIRST forecast month. ---
    const firstForecast = forecast[0];
    const sameMonthLastYearDate = shiftMonths(firstForecast.date, -12);
    const sameMonthLastYearActual = historyMap.get(sameMonthLastYearDate);
    const vsChangePct =
      sameMonthLastYearActual != null
        ? ((firstForecast.yhat - sameMonthLastYearActual) / sameMonthLastYearActual) * 100
        : null;
    const lossRate = data.loss_rate;
    const recommendedProduction = lossRate != null ? firstForecast.yhat / (1 - lossRate) : null;

    // --- Insight: lowest/highest month across all 12 forecast months. ---
    let lowIdx = 0;
    let highIdx = 0;
    forecast.forEach((f, i) => {
      if (f.yhat < forecast[lowIdx].yhat) lowIdx = i;
      if (f.yhat > forecast[highIdx].yhat) highIdx = i;
    });
    const lowMonth = forecast[lowIdx];
    const highMonth = forecast[highIdx];
    const insightPct = Math.round(((highMonth.yhat - lowMonth.yhat) / lowMonth.yhat) * 100);
    const insightRising = highIdx > lowIdx;

    // --- Table rows: all 12 forecast months. ---
    const tableRows = forecast.map((f) => {
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
      yTicks,
      forecastIsHigherAtEnd,
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
  }, [data]);

  const subtitle = 'Monthly billed water demand for all metered İZSU customers in İzmir (m³)';
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
            Latest available data: <b>{formatMonthLong(data.data_up_to)}</b> · forecasting the next 12 months from
            there
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
                Likely range {fmtMillions(computed.firstForecast.yhat_lower)}M –{' '}
                {fmtMillions(computed.firstForecast.yhat_upper)}M m³
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
                Average error
                <InfoTip id="tipAcc" label="How is accuracy measured?" align="right">
                  Mean absolute percentage error on the {TEST_MONTHS} test months (Jul 2022 – Aug 2024).
                </InfoTip>
              </div>
              <div className="kpi-value">
                {Number(data.metrics.mape).toFixed(1)}
                <span className="unit">%</span>
              </div>
              <div className="kpi-help">on {TEST_MONTHS} months the model never saw</div>
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
                  Next 12 months vs the same months last year
                </h2>
                <p className="card-sub">Million m³ · hover or tap a month for the figures</p>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={computed.chartRows}
                  margin={{ top: 30, right: 72, bottom: narrowChart ? 10 : 20, left: 10 }}
                >
                  <CartesianGrid horizontal vertical={false} stroke="#eef2f6" />
                  <XAxis
                    dataKey="date"
                    tick={(props) => <ForecastXAxisTick {...props} narrow={narrowChart} />}
                    interval={0}
                    height={narrowChart ? 30 : 40}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: '#475569' }}
                    tickFormatter={(value) => `${(value / 1_000_000).toFixed(0)}M`}
                    domain={[computed.yDomainMin, computed.yDomainMax]}
                    ticks={computed.yTicks}
                    allowDataOverflow
                    label={{
                      value: 'Demand (million m³)',
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 11, textAnchor: 'middle', fill: '#475569' },
                    }}
                  />
                  <Tooltip content={<ForecastChartTooltip />} cursor={{ stroke: '#cbd5e1', strokeWidth: 1 }} />
                  <Area
                    type="monotone"
                    dataKey="range"
                    stroke="none"
                    fill="#0d7f80"
                    fillOpacity={0.15}
                    connectNulls
                    activeDot={false}
                    name="Likely range"
                  />
                  <Line
                    type="monotone"
                    dataKey="lastYear"
                    stroke="#64748b"
                    strokeWidth={2}
                    dot={{ r: 2, fill: '#64748b' }}
                    name="Same month last year (actual)"
                    connectNulls
                    label={lastPointLabel(
                      'Last year',
                      '#64748b',
                      computed.chartRows.length - 1,
                      computed.forecastIsHigherAtEnd ? 16 : -12
                    )}
                  />
                  <Line
                    type="monotone"
                    dataKey="yhat"
                    stroke="#0d7f80"
                    strokeWidth={3}
                    dot={{ r: 3, fill: '#fff', stroke: '#0d7f80', strokeWidth: 2 }}
                    name="Forecast"
                    connectNulls
                    label={lastPointLabel(
                      'Forecast',
                      '#0d7f80',
                      computed.chartRows.length - 1,
                      computed.forecastIsHigherAtEnd ? -12 : 16
                    )}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="legend" aria-hidden="true">
              <span>
                <i className="lg-teal" />
                Forecast
              </span>
              <span>
                <i className="lg-grey" />
                Same month last year (actual)
              </span>
              <span>
                <i className="lg-band" />
                Likely range
              </span>
            </div>
          </section>

          <section className="card" aria-labelledby="tableTitle">
            <div className="card-head" style={{ paddingBottom: 6 }}>
              <div>
                <h2 className="card-title" id="tableTitle">
                  Monthly forecast
                </h2>
                <p className="card-sub">Next 12 months · million m³</p>
              </div>
              <button className="btn" type="button" onClick={() => exportCsv(computed.tableRows)}>
                <DownloadIcon />
                Export CSV
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <caption className="sr-only">
                  Monthly forecast with likely range and comparison to the same month last year
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    <th scope="col">Forecast</th>
                    <th scope="col">Same month last year</th>
                    <th scope="col">Change</th>
                    <th scope="col">Likely range</th>
                  </tr>
                </thead>
                <tbody>
                  {computed.tableRows.map((r) => {
                    const up = r.changePct !== null && r.changePct >= 0;
                    return (
                      <tr key={r.date}>
                        <td className="month">{r.monthLabel}</td>
                        <td>
                          <b>{fmtMillions(r.yhat, 2)}M</b>
                        </td>
                        <td>{r.lastYear != null ? `${fmtMillions(r.lastYear, 2)}M` : '—'}</td>
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
                        <td className="muted">
                          {fmtMillions(r.low, 1)}M – {fmtMillions(r.high, 1)}M
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="table-note">
              Likely range: in past testing, actual demand landed inside it about 8–9 months in 10. The safe
              production plan uses the top of the range. Change compares the forecast with actual billed demand in
              the same month one year earlier.
            </div>
          </section>

          <footer className="foot">
            <div className="foot-line">
              <span>
                Model: {data.model_name} · trained on {formatMonthShort(data.train_start)} –{' '}
                {formatMonthShort(data.train_end)} ({computed.trainedMonths} months)
              </span>
              <InfoTip id="tipModel" label="About the model">
                {data.model_name.includes('Ensemble')
                  ? 'Two models, Prophet and SARIMA, learn the trend and the summer/winter pattern from 10 years of billing data. The system averages them because, in testing, the average was more accurate than either model alone.'
                  : 'The model learns the trend and the summer/winter pattern from past billed demand.'}
              </InfoTip>
            </div>
          </footer>
        </>
      )}
    </AppLayout>
  );
}

export default Dashboard;
