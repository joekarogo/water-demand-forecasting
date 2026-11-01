import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import InfoTip from './components/InfoTip';
import { useViewportWidth } from './utils/useViewportWidth';
import { RetryIcon, ErrorTriangleIcon, EmptyForecastIcon, UpTriangleIcon, DownTriangleIcon } from './layout/icons';
import {
  formatMonthShort,
  formatMonthShortYY,
  formatMonthLong,
  formatPublishedDate,
  formatDateLong,
  fmtTRY,
  fmtTRYMillions,
  fmtPercentChange,
} from './utils/format';
import './App.css';

const API_URL = '/api/revenue/scenario';

// The May 2025 İzmir tariff change, as per-band % increases on top of the
// July 2024 prices this app otherwise prices everything at. January
// 2025's increase is deliberately excluded: sources disagree on its size
// (26% vs 30%).
const MAY_2025_PRESET = [0, 15, 25, 35];

function defaultScenario(name) {
  return {
    name,
    mode: 'uniform',
    uniformPct: '10',
    steps: { housing: ['0', '0', '0', '0'], workplace: ['0', '0', '0', '0'] },
    elasticityMode: 'none', // none | typical | custom
    customElasticity: '0.35',
    scope: 'housing', // housing | all
  };
}

function elasticityValue(scenario) {
  if (scenario.elasticityMode === 'none') return 0;
  if (scenario.elasticityMode === 'typical') return -0.35;
  const n = Number(scenario.customElasticity);
  return Number.isFinite(n) ? -Math.abs(n) : 0;
}

function toApiScenario(scenario) {
  const base = {
    name: scenario.name,
    mode: scenario.mode,
    elasticity: elasticityValue(scenario),
    elasticity_scope: scenario.scope,
  };
  if (scenario.mode === 'uniform') {
    return { ...base, uniform_pct: Number(scenario.uniformPct) || 0 };
  }
  return {
    ...base,
    steps: {
      housing: scenario.steps.housing.map((v) => Number(v) || 0),
      workplace: scenario.steps.workplace.map((v) => Number(v) || 0),
    },
  };
}

// Server field errors come back as "scenarios[0].uniform_pct" etc. — pull
// out the ones for a given panel index and re-key them by the bare field
// name the panel's inputs use.
function errorsForScenario(fieldErrors, index) {
  const prefix = `scenarios[${index}].`;
  const out = {};
  Object.entries(fieldErrors || {}).forEach(([key, message]) => {
    if (key.startsWith(prefix)) {
      const field = key.slice(prefix.length);
      // "steps.housing[1]" -> group under "steps" so one message covers
      // the whole step-inputs block rather than needing 8 separate slots.
      const bucket = field.startsWith('steps') ? 'steps' : field.startsWith('uniform_pct') ? 'uniform_pct' : field;
      out[bucket] = out[bucket] || message;
    }
  });
  return out;
}

// Real band ranges come from the API's tariffs_in_use (never hardcoded —
// thresholds could differ for water vs wastewater bands, change over time,
// or differ between housing and workplace, which is why both are checked
// and shown together when they disagree).
function bandRangeLabel(band) {
  if (!band) return '';
  if (band.max == null) return `${band.min}+ m³`;
  return `${band.min}–${band.max} m³`;
}

function bandRowLabel(housingBand, workplaceBand) {
  const h = bandRangeLabel(housingBand);
  const w = bandRangeLabel(workplaceBand);
  if (h && w && h !== w) return `${h} (housing) · ${w} (workplace)`;
  return h || w;
}

function ScenarioChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="chart-tooltip" role="group" aria-label={`${formatMonthLong(label)} details`}>
      <p className="chart-tooltip-label">{formatMonthLong(label)}</p>
      {payload.map((p) => (
        <p key={p.dataKey}>
          {p.name}: {fmtTRY(p.value)}
        </p>
      ))}
    </div>
  );
}

function ScenarioPanel({ index, label, scenario, onChange, errors, onApplyPreset, onRemove, housingBands, workplaceBands }) {
  const stepErr = errors.steps;
  const update = (patch) => onChange({ ...scenario, ...patch });

  return (
    <section className="card scenario-panel" aria-labelledby={`scenarioTitle${index}`}>
      <div className="card-head" style={{ paddingBottom: 6, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label htmlFor={`scenarioName${index}`} className="sr-only">
            Scenario {label} name
          </label>
          <input
            className="input"
            id={`scenarioName${index}`}
            value={scenario.name}
            maxLength={60}
            onChange={(e) => update({ name: e.target.value })}
            style={{ fontWeight: 600, fontSize: 15 }}
          />
        </div>
        {onRemove && (
          <button type="button" className="btn" onClick={onRemove}>
            Remove scenario {label}
          </button>
        )}
      </div>

      <div style={{ padding: '0 20px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="ctl-group">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span className="ctl-label" id={`scenarioModeLabel${index}`}>
              Price change
            </span>
            <button type="button" className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => onApplyPreset(index)}>
              May 2025 İzmir change
            </button>
          </div>
          <div className="segmented" role="radiogroup" aria-labelledby={`scenarioModeLabel${index}`}>
            <button type="button" role="radio" aria-checked={scenario.mode === 'uniform'} onClick={() => update({ mode: 'uniform' })}>
              Uniform %
            </button>
            <button type="button" role="radio" aria-checked={scenario.mode === 'per_step'} onClick={() => update({ mode: 'per_step' })}>
              Per step
            </button>
          </div>
        </div>

        {scenario.mode === 'uniform' ? (
          <div className="field">
            <label htmlFor={`uniformPct${index}`}>% change on every band (water &amp; wastewater)</label>
            <input
              className="input"
              type="number"
              id={`uniformPct${index}`}
              value={scenario.uniformPct}
              min={-50}
              max={100}
              step={1}
              aria-invalid={errors.uniform_pct ? 'true' : 'false'}
              onChange={(e) => update({ uniformPct: e.target.value })}
            />
            {errors.uniform_pct && <span className="field-err">{errors.uniform_pct}</span>}
          </div>
        ) : (
          <div className="field">
            <span>Per-band % change — housing &amp; workplace only</span>
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="district-table">
                <thead>
                  <tr>
                    <th scope="col">Band</th>
                    <th scope="col">Housing %</th>
                    <th scope="col">Workplace %</th>
                  </tr>
                </thead>
                <tbody>
                  {[0, 1, 2, 3].map((bi) => {
                    const bandLabel = bandRowLabel(housingBands[bi], workplaceBands[bi]) || `Band ${bi + 1}`;
                    return (
                      <tr key={bi}>
                        <th scope="row" style={{ textAlign: 'left' }}>
                          {bandLabel}
                        </th>
                        <td>
                          <input
                            className="input"
                            type="number"
                            aria-label={`${bandLabel} housing % change`}
                            value={scenario.steps.housing[bi]}
                            min={-50}
                            max={100}
                            onChange={(e) => {
                              const housing = [...scenario.steps.housing];
                              housing[bi] = e.target.value;
                              update({ steps: { ...scenario.steps, housing } });
                            }}
                          />
                        </td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            aria-label={`${bandLabel} workplace % change`}
                            value={scenario.steps.workplace[bi]}
                            min={-50}
                            max={100}
                            onChange={(e) => {
                              const workplace = [...scenario.steps.workplace];
                              workplace[bi] = e.target.value;
                              update({ steps: { ...scenario.steps, workplace } });
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {stepErr && <span className="field-err">{stepErr}</span>}
            <span className="field-hint">Every other tariff type is left unchanged in per-step mode.</span>
          </div>
        )}

        <div className="ctl-group">
          <span className="ctl-label" id={`scenarioElLabel${index}`}>
            Demand response
          </span>
          <div className="segmented" role="radiogroup" aria-labelledby={`scenarioElLabel${index}`}>
            <button type="button" role="radio" aria-checked={scenario.elasticityMode === 'none'} onClick={() => update({ elasticityMode: 'none' })}>
              None
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scenario.elasticityMode === 'typical'}
              onClick={() => update({ elasticityMode: 'typical' })}
            >
              Typical (−0.35)
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scenario.elasticityMode === 'custom'}
              onClick={() => update({ elasticityMode: 'custom' })}
            >
              Custom
            </button>
          </div>
        </div>

        {scenario.elasticityMode === 'custom' && (
          <div className="field">
            <label htmlFor={`elasticity${index}`}>Elasticity magnitude (0 to 1; applied as negative)</label>
            <input
              className="input"
              type="number"
              id={`elasticity${index}`}
              value={scenario.customElasticity}
              min={0}
              max={1}
              step={0.05}
              aria-invalid={errors.elasticity ? 'true' : 'false'}
              onChange={(e) => update({ customElasticity: e.target.value })}
            />
            {errors.elasticity && <span className="field-err">{errors.elasticity}</span>}
          </div>
        )}

        <div className="field">
          <label htmlFor={`scope${index}`}>Apply demand response to</label>
          <select className="input" id={`scope${index}`} value={scenario.scope} onChange={(e) => update({ scope: e.target.value })}>
            <option value="housing">Housing only (default)</option>
            <option value="all">All customer groups</option>
          </select>
          <span className="field-hint">Housing = the Konut customer group.</span>
        </div>
      </div>
    </section>
  );
}

function ChangeCell({ value, pct }) {
  if (value == null) return <span>—</span>;
  const up = value >= 0;
  return (
    <span className={up ? 'delta-up' : 'delta-down'} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {up ? <UpTriangleIcon /> : <DownTriangleIcon />}
      <span className="sr-only">{up ? 'Up ' : 'Down '}</span>
      {fmtTRY(Math.abs(value))}
      {pct != null && (
        <span className="kpi-help" style={{ marginLeft: 2 }}>
          ({fmtPercentChange(pct)}% {up ? 'higher' : 'lower'})
        </span>
      )}
    </span>
  );
}

function RevenueScenarios() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const hasRevenueView = useMemo(() => Boolean(session?.permissions?.includes('revenue:view')), [session]);

  const [status, setStatus] = useState('loading'); // loading | ready | empty | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [data, setData] = useState(null);
  const [monthIndex, setMonthIndex] = useState(0);

  const [includeB, setIncludeB] = useState(false);
  const [scenarioA, setScenarioA] = useState(defaultScenario('Scenario A'));
  const [scenarioB, setScenarioB] = useState(defaultScenario('Scenario B'));

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

  const applyPreset = useCallback((index) => {
    const steps = { housing: MAY_2025_PRESET.map(String), workplace: MAY_2025_PRESET.map(String) };
    if (index === 0) {
      setScenarioA((s) => ({ ...s, mode: 'per_step', steps }));
    } else {
      setScenarioB((s) => ({ ...s, mode: 'per_step', steps }));
    }
  }, []);

  const fetchScenarios = useCallback(async () => {
    setStatus((prev) => (prev === 'ready' ? 'ready' : 'loading'));
    setFieldErrors({});
    try {
      const body = { scenarios: [toApiScenario(scenarioA)] };
      if (includeB) body.scenarios.push(toApiScenario(scenarioB));

      const response = await apiFetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (handleAuthError(response)) return;
      if (response.status === 403) {
        setStatus('forbidden');
        return;
      }
      if (response.status === 404) {
        setStatus('empty');
        return;
      }
      const resBody = await response.json().catch(() => ({}));
      if (response.status === 400) {
        setFieldErrors(resBody.fields || {});
        setStatus('ready');
        return;
      }
      if (!response.ok) {
        setErrorReference(resBody.reference || null);
        setStatus('error');
        return;
      }
      setData(resBody);
      setStatus('ready');
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
    }
  }, [scenarioA, scenarioB, includeB, handleAuthError]);

  useEffect(() => {
    if (sessionLoading || !session || !hasRevenueView) return;
    const t = setTimeout(() => fetchScenarios(), 350);
    return () => clearTimeout(t);
  }, [sessionLoading, session, hasRevenueView, fetchScenarios]);

  const months = useMemo(() => data?.months || [], [data]);
  const month = months[monthIndex] || null;
  const housingBands = useMemo(() => data?.tariffs_in_use?.['KONUT ABONELERİ'] || [], [data]);
  const workplaceBands = useMemo(() => data?.tariffs_in_use?.['İŞYERİ ABONELERİ'] || [], [data]);

  const viewportWidth = useViewportWidth();
  const narrowChart = viewportWidth < 600;

  const chartRows = useMemo(() => {
    return months.map((m) => {
      const row = { month: m.month, Baseline: m.baseline.total.mid };
      m.scenarios.forEach((s) => {
        row[s.name] = s.total.mid;
      });
      return row;
    });
  }, [months]);

  // One sentence per active scenario (1 or 2), e.g.: "Under Scenario A in
  // September 2024, revenue would be about ₺1.14B — ₺72.6M (6.8%) more
  // than the baseline." Every money figure uses the shared, billions-aware
  // formatter, never ad-hoc formatting.
  const summarySentences = useMemo(() => {
    if (!month) return [];
    return month.scenarios.map((s) => {
      const changeIsZero = Math.round(Math.abs(s.change_try) * 10) === 0;
      const more = s.change_try >= 0;
      return (
        <p key={s.name}>
          Under <b>{s.name}</b> in <b>{formatMonthLong(month.month)}</b>, revenue would be about{' '}
          <b>{fmtTRYMillions(s.total.mid)}</b>
          {changeIsZero ? (
            ' — about the same as the baseline.'
          ) : (
            <>
              {' — '}
              <b>{fmtTRYMillions(Math.abs(s.change_try))}</b>
              {s.change_pct != null ? ` (${fmtPercentChange(s.change_pct)}%)` : ''} {more ? 'more' : 'less'} than the
              baseline.
            </>
          )}
        </p>
      );
    });
  }, [month]);

  const errorsA = errorsForScenario(fieldErrors, 0);
  const errorsB = errorsForScenario(fieldErrors, 1);

  const subtitle = 'What happens to revenue if prices change?';

  const showPanels = status !== 'error' && status !== 'forbidden' && status !== 'empty';

  return (
    <AppLayout title="Revenue scenarios" subtitle={subtitle} requiredPermission="revenue:view">
      {status === 'error' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>Revenue scenarios couldn't be calculated.</h2>
          <p>
            Try again in a moment.
            {errorReference
              ? ` If it keeps happening, tell your system administrator (reference ${errorReference}).`
              : ' If it keeps happening, tell your system administrator.'}
          </p>
          <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} onClick={fetchScenarios}>
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
          <h2>You don't have permission to view revenue scenarios.</h2>
        </section>
      )}

      {status === 'empty' && (
        <section className="card error-card" role="status">
          <span className="empty-icon" aria-hidden="true">
            <EmptyForecastIcon />
          </span>
          <h2>No forecast published</h2>
          <p>Revenue scenarios are built from the published city forecast, and none has been published yet.</p>
        </section>
      )}

      {showPanels && (
        <>
          <p className="published">
            <span className="dot" aria-hidden="true" style={{ background: '#94a3b8' }} />
            <span>
              Compared with the baseline at July 2024 prices, excluding taxes. These are billed charges, not cash
              collected — some bills go unpaid. Scenarios are calculated live and not saved.
            </span>
            <InfoTip id="tipScenarioMethod" label="How are scenarios calculated?">
              <b>How are scenarios calculated?</b>
              <br />
              Elasticity values come from international meta-analyses of residential water demand, not measured for
              İzmir specifically. This is a constant-elasticity approximation, not a full model of customer behaviour.
              <br />
              Price steps are assumed to apply per subscriber per month, as on monthly bills.
              <br />
              The "May 2025 İzmir change" preset applies May 2025's step increases on top of July 2024 prices. The
              January 2025 increase is excluded because sources disagree on its size (26% vs 30%).
              <br />
              The low–high range reflects city forecast uncertainty only. The same lower-bound caveat as Revenue
              estimate still applies here.
            </InfoTip>
          </p>

          <div className="scenario-panels">
            <ScenarioPanel
              index={0}
              label="A"
              scenario={scenarioA}
              onChange={setScenarioA}
              errors={errorsA}
              onApplyPreset={applyPreset}
              housingBands={housingBands}
              workplaceBands={workplaceBands}
            />
            {includeB ? (
              <ScenarioPanel
                index={1}
                label="B"
                scenario={scenarioB}
                onChange={setScenarioB}
                errors={errorsB}
                onApplyPreset={applyPreset}
                onRemove={() => setIncludeB(false)}
                housingBands={housingBands}
                workplaceBands={workplaceBands}
              />
            ) : (
              <section className="card scenario-panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 160 }}>
                <button className="btn" type="button" onClick={() => setIncludeB(true)}>
                  Compare a second scenario
                </button>
              </section>
            )}
          </div>

          {!data && status === 'loading' && (
            <>
              <div className="state-banner" role="status" aria-live="polite">
                <span className="state-banner-spinner" aria-hidden="true" />
                <div>Calculating revenue scenarios…</div>
              </div>
              <div className="card sk-table" aria-hidden="true">
                <div className="sk" style={{ width: '30%', height: 14 }} />
                <div className="sk" style={{ width: '40%', height: 28 }} />
                <div className="sk" style={{ height: 120 }} />
              </div>
            </>
          )}

          {!data && Object.keys(fieldErrors).length > 0 && (
            <p className="field-hint">Fix the errors above to see results.</p>
          )}

          {month && (
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
                  <select className="input" id="monthSel" value={monthIndex} onChange={(e) => setMonthIndex(Number(e.target.value))}>
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
              </section>

              <section className="summary" aria-label="Summary" aria-live="polite">
                {summarySentences}
              </section>

              <section className="card" aria-labelledby="scenarioTableTitle">
                <div className="card-head" style={{ paddingBottom: 6 }}>
                  <div>
                    <h2 className="card-title" id="scenarioTableTitle">
                      {formatMonthLong(month.month)} — baseline vs scenarios
                    </h2>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="district-table">
                    <thead>
                      <tr>
                        <th scope="col">Figure</th>
                        <th scope="col">Baseline</th>
                        <th scope="col">{month.scenarios[0]?.name}</th>
                        {month.scenarios[1] && <th scope="col">{month.scenarios[1].name}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left' }}>
                          Water (₺)
                        </th>
                        <td>{fmtTRY(month.baseline.water.mid)}</td>
                        <td>{fmtTRY(month.scenarios[0].water.mid)}</td>
                        {month.scenarios[1] && <td>{fmtTRY(month.scenarios[1].water.mid)}</td>}
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left' }}>
                          Wastewater (₺)
                        </th>
                        <td>{fmtTRY(month.baseline.wastewater.mid)}</td>
                        <td>{fmtTRY(month.scenarios[0].wastewater.mid)}</td>
                        {month.scenarios[1] && <td>{fmtTRY(month.scenarios[1].wastewater.mid)}</td>}
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left' }}>
                          <b>Total (₺)</b>
                        </th>
                        <td>
                          <b>{fmtTRY(month.baseline.total.mid)}</b>
                        </td>
                        <td>
                          <b>{fmtTRY(month.scenarios[0].total.mid)}</b>
                        </td>
                        {month.scenarios[1] && (
                          <td>
                            <b>{fmtTRY(month.scenarios[1].total.mid)}</b>
                          </td>
                        )}
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left' }}>
                          Change vs baseline
                        </th>
                        <td>—</td>
                        <td>
                          <ChangeCell value={month.scenarios[0].change_try} pct={month.scenarios[0].change_pct} />
                        </td>
                        {month.scenarios[1] && (
                          <td>
                            <ChangeCell value={month.scenarios[1].change_try} pct={month.scenarios[1].change_pct} />
                          </td>
                        )}
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left' }}>
                          Volume change (m³)
                        </th>
                        <td>—</td>
                        <td>{Math.round(month.scenarios[0].volume_change_m3).toLocaleString('en-US')}</td>
                        {month.scenarios[1] && <td>{Math.round(month.scenarios[1].volume_change_m3).toLocaleString('en-US')}</td>}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card" aria-labelledby="totalsTableTitle">
                <div className="card-head" style={{ paddingBottom: 6 }}>
                  <div>
                    <h2 className="card-title" id="totalsTableTitle">
                      12-month total — baseline vs scenarios
                    </h2>
                  </div>
                </div>
                <div className="table-wrap">
                  <table className="district-table">
                    <thead>
                      <tr>
                        <th scope="col">Figure</th>
                        <th scope="col">Baseline</th>
                        <th scope="col">{data.twelve_month_totals.scenarios[0]?.name}</th>
                        {data.twelve_month_totals.scenarios[1] && <th scope="col">{data.twelve_month_totals.scenarios[1].name}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left' }}>
                          <b>Total (₺)</b>
                        </th>
                        <td>
                          <b>{fmtTRYMillions(data.twelve_month_totals.baseline.total.mid)}</b>
                        </td>
                        <td>
                          <b>{fmtTRYMillions(data.twelve_month_totals.scenarios[0].total.mid)}</b>
                        </td>
                        {data.twelve_month_totals.scenarios[1] && (
                          <td>
                            <b>{fmtTRYMillions(data.twelve_month_totals.scenarios[1].total.mid)}</b>
                          </td>
                        )}
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left' }}>
                          Change vs baseline
                        </th>
                        <td>—</td>
                        <td>
                          <ChangeCell
                            value={data.twelve_month_totals.scenarios[0].change_try}
                            pct={data.twelve_month_totals.scenarios[0].change_pct}
                          />
                        </td>
                        {data.twelve_month_totals.scenarios[1] && (
                          <td>
                            <ChangeCell
                              value={data.twelve_month_totals.scenarios[1].change_try}
                              pct={data.twelve_month_totals.scenarios[1].change_pct}
                            />
                          </td>
                        )}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card" aria-labelledby="scenarioChartTitle">
                <div className="card-head">
                  <div>
                    <h2 className="card-title" id="scenarioChartTitle">
                      12-month revenue — baseline vs scenarios
                    </h2>
                  </div>
                </div>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartRows} margin={{ top: 20, right: 20, bottom: 10, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                      <XAxis
                        dataKey="month"
                        tickFormatter={narrowChart ? formatMonthShortYY : formatMonthShort}
                        tick={{ fontSize: 11, fill: '#475569' }}
                        interval={narrowChart ? 'preserveStartEnd' : 0}
                        minTickGap={narrowChart ? 30 : 10}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: '#475569' }}
                        tickFormatter={(value) => `₺${(value / 1_000_000).toFixed(0)}M`}
                      />
                      <Tooltip content={<ScenarioChartTooltip />} />
                      <Legend />
                      <Line type="monotone" dataKey="Baseline" stroke="#7fa9c7" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey={month.scenarios[0]?.name} stroke="#0b5c8f" strokeWidth={2} strokeDasharray="6 3" dot={false} />
                      {month.scenarios[1] && (
                        <Line type="monotone" dataKey={month.scenarios[1].name} stroke="#b5542e" strokeWidth={2} strokeDasharray="2 2" dot={false} />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>

              <footer className="foot">
                <p className="prov">
                  Forecast published <b>{formatPublishedDate(data.published_at)}</b>
                  {' · '}Tariff dated <b>{data.tariff_version_date ? formatDateLong(data.tariff_version_date) : '—'}</b>
                </p>
              </footer>
            </>
          )}
        </>
      )}
    </AppLayout>
  );
}

export default RevenueScenarios;
