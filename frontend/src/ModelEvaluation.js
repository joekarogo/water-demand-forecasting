import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import InfoTip from './components/InfoTip';
import { RetryIcon, ErrorTriangleIcon, InfoIcon, EmptyForecastIcon } from './layout/icons';
import './App.css';

const API_URL = '/api/model-evaluation';

// Stable colour per model name (alphabetical), reused across every chart
// on this page so the same model always reads the same colour.
const MODEL_COLORS = ['#0b5c8f', '#2f9e68', '#b5542e', '#7fa9c7', '#8a5fbd', '#c98a2b'];
function colorFor(modelName, allModelNames) {
  const sorted = [...allModelNames].sort();
  const i = sorted.indexOf(modelName);
  return MODEL_COLORS[i % MODEL_COLORS.length];
}

const ROLLING_HORIZONS = [1, 3, 6, 12];
const SEASON_ORDER = ['winter', 'summer', 'other'];
const SEASON_LABELS = { winter: 'Winter', summer: 'Summer', other: 'Other months' };

function pct(value, digits = 2) {
  return value == null ? '—' : `${Number(value).toFixed(digits)}%`;
}
// "about 9 in 10" phrasing for a 0-1 share, rounded to the nearest tenth.
function wholeOutOfTen(share) {
  if (share == null) return '—';
  return `${Math.round(share * 10)} in 10`;
}
function num(value, digits = 0) {
  return value == null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}
function pValueText(value) {
  if (value === 'not computable' || value == null) return 'not computable';
  if (value < 0.001) return '< 0.001';
  return value.toFixed(3);
}
function isSignificant(pValue) {
  return typeof pValue === 'number' && pValue < 0.05;
}
// Oxford-joins a list of names, e.g. ["A"] -> "A", ["A","B"] -> "A and B",
// ["A","B","C"] -> "A, B and C".
function formatList(items) {
  if (!items || items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const TECHNICAL_DETAILS_HASH = '#technical-details';

// Four plain-language, jargon-free facts for the "In short" card, each
// built strictly from the same stored sections the six sections below
// already use — never a separate, independently-invented claim. A fact
// whose precondition data isn't available is simply left out rather than
// guessed, so this card degrades the same way the rest of the page does.
function buildShortFacts(data) {
  const testSet = data?.sections?.test_set_metrics;
  const rolling = data?.sections?.rolling_origin;
  const coverage = data?.sections?.coverage;
  const verdict = data?.verdict;
  const facts = [];

  if (verdict && testSet) {
    facts.push(`Forecasts are typically within about ${Math.round(verdict.best_mape)}% of actual demand.`);
  }

  const bestCoverage = verdict && coverage?.one_sided_by_model ? coverage.one_sided_by_model[verdict.best] : null;
  if (bestCoverage?.has_interval) {
    const h1 = bestCoverage.by_horizon[1]?.at_or_below_upper;
    const h12 = bestCoverage.by_horizon[12]?.at_or_below_upper;
    if (h1 != null && h12 != null) {
      facts.push(
        `The upper end of the range held about ${wholeOutOfTen(h1)} months (about ${wholeOutOfTen(
          h12
        )} at a 12-month horizon), which is why the safe production plan uses it.`
      );
    }
  }

  if (rolling?.models && verdict?.baseline_name) {
    const bestR = rolling.models[verdict.best];
    const baseR = rolling.models[verdict.baseline_name];
    const closeAt = (h) => bestR?.[h] && baseR?.[h] && Math.abs(bestR[h].mean_mape - baseR[h].mean_mape) < 1.5;
    const clearlyBetterAt12 = bestR?.[12] && baseR?.[12] && bestR[12].mean_mape < baseR[12].mean_mape - 0.5;
    if (closeAt(1) && closeAt(3) && clearlyBetterAt12) {
      facts.push(
        `For 1–3 months ahead, a simple "same as last year" guess is as accurate or slightly more accurate; the model's advantage shows at 12 months.`
      );
    }
  }

  if (bestCoverage?.has_interval) {
    const avgUpper = bestCoverage.average?.at_or_below_upper;
    const avgLower = bestCoverage.average?.at_or_above_lower;
    if (avgUpper != null && avgLower != null && 1 - avgLower > 1 - avgUpper) {
      facts.push('Treat the lower end of the range as optimistic — in past testing, actual demand fell below it more often than it fell above the upper end.');
    }
  }

  return facts;
}

// A calm, non-alarming notice for a section the stored files didn't
// cover — never hidden, never styled as an error, since a missing
// result file isn't a bug in this page.
function NotAvailable({ what }) {
  return (
    <div className="insight" role="status">
      <InfoIcon />
      <span>{what} isn't available from the stored evaluation files in this deployment.</span>
    </div>
  );
}

function ModelEvaluation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session, loading: sessionLoading, clearSession } = useSession();

  const [status, setStatus] = useState('loading'); // loading | ready | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [data, setData] = useState(null);

  // "Technical details" starts collapsed, but a link ending in
  // #technical-details lands with it already open — and toggling it
  // keeps the hash in sync, so the open/closed state itself is linkable.
  const [detailsOpen, setDetailsOpen] = useState(location.hash === TECHNICAL_DETAILS_HASH);
  useEffect(() => {
    setDetailsOpen(location.hash === TECHNICAL_DETAILS_HASH);
  }, [location.hash]);
  const handleDetailsToggle = (e) => {
    const open = e.target.open;
    setDetailsOpen(open);
    if (open && location.hash !== TECHNICAL_DETAILS_HASH) {
      navigate({ hash: TECHNICAL_DETAILS_HASH }, { replace: true });
    } else if (!open && location.hash === TECHNICAL_DETAILS_HASH) {
      navigate({ hash: '' }, { replace: true });
    }
  };

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

  const fetchData = useCallback(async () => {
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
      setData(body);
      setStatus('ready');
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
    }
  }, [handleAuthError]);

  useEffect(() => {
    if (sessionLoading || !session) return;
    fetchData();
  }, [sessionLoading, session, fetchData]);

  const sections = data?.sections || {};
  const unavailableReasons = {};
  (data?.unavailable || []).forEach((u) => {
    unavailableReasons[u.section] = u.reason;
  });

  const testSet = sections.test_set_metrics;
  const rolling = sections.rolling_origin;
  const dm = sections.diebold_mariano;
  const coverage = sections.coverage;
  const errorAnalysis = sections.error_analysis;
  const protocol = sections.protocol;

  const noRangeModels = coverage?.one_sided_by_model
    ? Object.entries(coverage.one_sided_by_model)
        .filter(([, d]) => !d.has_interval)
        .map(([model]) => model)
    : [];

  // The verdict is computed server-side (backend/modelEvaluation.js),
  // from the actual stored test-set MAPE and Diebold-Mariano p-values —
  // never re-derived here, so this page can't drift from the one place
  // that checks significance against the 0.05 threshold.
  const verdict = data?.verdict || null;

  // --- "Does it hold up over time?" chart + spread table -----------------
  let rollingChartRows = null;
  let rollingModelNames = [];
  if (rolling) {
    rollingModelNames = Object.keys(rolling.models);
    rollingChartRows = ROLLING_HORIZONS.map((h) => {
      const row = { horizon: `${h} mo` };
      rollingModelNames.forEach((m) => {
        const cell = rolling.models[m][h];
        if (cell) row[m] = cell.mean_mape;
      });
      return row;
    });
  }

  // --- "Where does it go wrong?" chart -----------------------------------
  let seasonChartRows = null;
  let seasonModelNames = [];
  if (errorAnalysis) {
    seasonModelNames = Object.keys(errorAnalysis.models);
    const seasonsPresent = SEASON_ORDER.filter((s) => seasonModelNames.some((m) => s in errorAnalysis.models[m].mape_by_season));
    seasonChartRows = seasonsPresent.map((s) => {
      const row = { season: SEASON_LABELS[s] || s };
      seasonModelNames.forEach((m) => {
        const v = errorAnalysis.models[m].mape_by_season[s];
        if (v != null) row[m] = v;
      });
      return row;
    });
  }

  const provenanceFiles = [...new Set((data?.provenance || []).map((p) => p.file))];
  const shortFacts = data ? buildShortFacts(data) : [];

  return (
    <AppLayout title="Model evaluation" subtitle="How good is the forecast, really?" requiredPermission="forecast:view">
      {status === 'loading' && (
        <div className="state-banner" role="status" aria-live="polite">
          <span className="state-banner-spinner" aria-hidden="true" />
          <div>Loading model evaluation…</div>
        </div>
      )}

      {status === 'error' && (
        <section className="card error-card" role="alert">
          <span className="error-icon" aria-hidden="true">
            <ErrorTriangleIcon />
          </span>
          <h2>The model evaluation couldn't be loaded.</h2>
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
          <h2>You don't have permission to view model evaluation.</h2>
        </section>
      )}

      {status === 'ready' && data && (
        <>
          {Object.keys(sections).length === 0 && (
            <section className="card error-card" role="status">
              <span className="empty-icon" aria-hidden="true">
                <EmptyForecastIcon />
              </span>
              <h2>No evaluation results are available</h2>
              <p>None of the stored evaluation files could be read in this deployment.</p>
            </section>
          )}

          {shortFacts.length > 0 && (
            <section className="card" aria-labelledby="inShortTitle">
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="inShortTitle">
                    In short
                  </h2>
                </div>
              </div>
              <ul style={{ margin: '0 20px 18px', paddingLeft: 20, fontSize: 14 }}>
                {shortFacts.map((fact, i) => (
                  <li key={i} style={{ marginBottom: i < shortFacts.length - 1 ? 8 : 0 }}>
                    {fact}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <details className="disclosure" open={detailsOpen} onToggle={handleDetailsToggle}>
            <summary className="disclosure-summary">Technical details</summary>
            <div className="disclosure-content">
          {/* ---------- How accurate is it? ---------- */}
          <section className="card" aria-labelledby="accuracyTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="accuracyTitle">
                  How accurate is it?
                </h2>
              </div>
              <InfoTip id="accuracyTip" label="How these numbers are calculated">
                <p>
                  <b>MAE</b> (mean absolute error) is the average size of the miss, in m³. <b>RMSE</b> (root mean
                  squared error) is similar but weights large misses more heavily. <b>MAPE</b> (mean absolute
                  percentage error) expresses the same miss as a percentage of actual demand, which is why it's the
                  easiest of the three to compare across models.
                </p>
              </InfoTip>
            </div>
            {testSet ? (
              <>
                <div className="table-wrap" style={{ margin: '12px 20px' }}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Model</th>
                        <th scope="col">MAE (m³)</th>
                        <th scope="col">RMSE (m³)</th>
                        <th scope="col">MAPE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(testSet.models).map(([model, m]) => (
                        <tr key={model}>
                          <td>{model}</td>
                          <td>{num(m.mae)}</td>
                          <td>{num(m.rmse)}</td>
                          <td>{pct(m.mape)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {verdict && (
                  <div style={{ margin: '0 20px 18px', fontSize: 14 }}>
                    <p style={{ margin: '0 0 8px' }}>
                      On the 26-month held-out test set, <b>{verdict.best}</b> had the lowest MAPE ({pct(verdict.best_mape)}
                      ){verdict.baseline_name && (
                        <>
                          , ahead of <b>{verdict.baseline_name}</b> ({pct(verdict.baseline_mape)})
                        </>
                      )}
                      .
                    </p>
                    {verdict.baseline_models_tested.length > 0 && (
                      <p style={{ margin: '0 0 8px' }}>
                        {verdict.significant_against_baseline.length === 0 ? (
                          <>
                            In rolling-origin testing, this advantage over {formatList(verdict.baseline_models_tested)} was{' '}
                            <b>not statistically significant</b> at any of the tested horizons (
                            {verdict.baseline_horizons_tested.join(', ')} months) — see "Is the difference real?" below
                            before treating it as a clear win.
                          </>
                        ) : (
                          <>
                            In rolling-origin testing, this advantage was statistically significant against{' '}
                            {formatList(verdict.significant_against_baseline.map((p) => p.other))} — see "Is the
                            difference real?" below.
                          </>
                        )}
                      </p>
                    )}
                    {verdict.significant_variant_differences.length > 0 && (
                      <p style={{ margin: 0 }}>
                        The only significant difference found anywhere in this evaluation was{' '}
                        {verdict.significant_variant_differences.map((p, i) => (
                          <span key={i}>
                            between <b>{verdict.best}</b> and <b>{p.other}</b> at the {p.horizon}-month horizon, where{' '}
                            <b>{p.winner}</b> performed better (p = {pValueText(p.p_value)})
                            {i < verdict.significant_variant_differences.length - 1 ? '; ' : '.'}
                          </span>
                        ))}
                      </p>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div style={{ margin: '0 20px 18px' }}>
                <NotAvailable what="Test-set metrics" />
              </div>
            )}
          </section>

          {/* ---------- Does it hold up over time? ---------- */}
          <section className="card" aria-labelledby="horizonTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="horizonTitle">
                  Does it hold up over time?
                </h2>
              </div>
              <InfoTip id="rollingTip" label="What rolling-origin evaluation means">
                <p>
                  Rolling-origin evaluation repeats the forecast from many different starting points ("origins") in
                  the past, each time checking how accurate it was 1, 3, 6 and 12 months ahead. This shows whether
                  accuracy holds up further into the future, not just in one lucky test period.
                </p>
              </InfoTip>
            </div>
            {rolling ? (
              <>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={rollingChartRows} margin={{ top: 20, right: 20, bottom: 10, left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                      <XAxis dataKey="horizon" />
                      <YAxis unit="%" />
                      <Tooltip formatter={(v) => (typeof v === 'number' ? `${v.toFixed(2)}%` : v)} />
                      <Legend />
                      {rollingModelNames.map((m) => (
                        <Line key={m} type="monotone" dataKey={m} stroke={colorFor(m, rollingModelNames)} strokeWidth={2} dot />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div className="table-wrap" style={{ margin: '12px 20px 18px' }}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Model</th>
                        <th scope="col">Horizon</th>
                        <th scope="col">Mean MAPE</th>
                        <th scope="col">Min</th>
                        <th scope="col">Median</th>
                        <th scope="col">Max</th>
                        <th scope="col">Origins</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rollingModelNames.flatMap((m) =>
                        ROLLING_HORIZONS.filter((h) => rolling.models[m][h]).map((h) => {
                          const c = rolling.models[m][h];
                          return (
                            <tr key={`${m}-${h}`}>
                              <td>{m}</td>
                              <td>{h} mo</td>
                              <td>{pct(c.mean_mape)}</td>
                              <td>{pct(c.min_abs_pct_error)}</td>
                              <td>{pct(c.median_abs_pct_error)}</td>
                              <td>{pct(c.max_abs_pct_error)}</td>
                              <td>{c.n_origins}</td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                <p className="table-note" style={{ margin: '0 20px 18px' }}>
                  Min/median/max show the spread of the absolute percentage error across {rolling.n_origins_total ?? '—'}{' '}
                  origins at each horizon — the mean alone can hide how much worse the worst origin was.
                  {rolling.coverage_caveat ? ` ${rolling.coverage_caveat}` : ''}
                </p>
              </>
            ) : (
              <div style={{ margin: '0 20px 18px' }}>
                <NotAvailable what="Rolling-origin results" />
              </div>
            )}
          </section>

          {/* ---------- Is the difference real? ---------- */}
          <section className="card" aria-labelledby="dmTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="dmTitle">
                  Is the difference real?
                </h2>
              </div>
              <InfoTip id="pValueTip" label="What a p-value means here">
                <p>
                  The Diebold-Mariano test checks whether one model's forecast errors are genuinely smaller than
                  another's, or whether the gap could plausibly be chance. A <b>p-value</b> below 0.05 means the
                  difference is unlikely to be chance (conventionally "statistically significant"); above 0.05 means
                  it isn't — the two models can't be told apart with confidence from this data.
                </p>
              </InfoTip>
            </div>
            {dm ? (
              <>
                <div className="table-wrap" style={{ margin: '12px 20px' }}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Model A</th>
                        <th scope="col">Model B</th>
                        <th scope="col">Horizon</th>
                        <th scope="col">DM statistic</th>
                        <th scope="col">p-value</th>
                        <th scope="col">Verdict</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dm.pairs.map((p, i) => (
                        <tr key={i}>
                          <td>{p.model_a}</td>
                          <td>{p.model_b}</td>
                          <td>{p.horizon} mo</td>
                          <td>{typeof p.dm_statistic === 'number' ? p.dm_statistic.toFixed(3) : p.dm_statistic}</td>
                          <td>{pValueText(p.p_value)}</td>
                          <td>{isSignificant(p.p_value) ? 'Significant' : 'Not significant'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {dm.caveats.length > 0 && (
                  <ul style={{ margin: '0 20px 18px', fontSize: 13, color: 'var(--text-3)' }}>
                    {dm.caveats.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <div style={{ margin: '0 20px 18px' }}>
                <NotAvailable what="Diebold-Mariano results" />
              </div>
            )}
          </section>

          {/* ---------- Can you trust the range? ---------- */}
          <section className="card" aria-labelledby="coverageTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="coverageTitle">
                  Can you trust the range?
                </h2>
              </div>
              <InfoTip id="coverageTip" label="What coverage means">
                <p>
                  Every forecast comes with an 80% range (a low and a high estimate). <b>Coverage</b> is how often
                  the actual outcome really did fall inside that range when tested on past data — close to 80% means
                  the range is trustworthy; well below it means the range is too narrow. <b>One-sided</b> coverage
                  asks the narrower, more operational question: how often did the actual outcome stay at or below
                  the upper bound (or at or above the lower bound) on its own, regardless of the other side.
                </p>
              </InfoTip>
            </div>
            {coverage ? (
              <>
                <section className="kpis" aria-label="Coverage">
                  {Object.entries(coverage.two_sided_by_model_horizon).map(([model, byHorizon]) => (
                    <div className="card kpi" key={model}>
                      <div className="kpi-label">{model} — two-sided</div>
                      <div className="kpi-value">
                        {pct((byHorizon['1'] ?? byHorizon[1]) * 100, 1)}
                        <span className="unit">at 1 mo</span>
                      </div>
                      <div className="kpi-help">
                        {byHorizon['12'] != null || byHorizon[12] != null
                          ? `${pct((byHorizon['12'] ?? byHorizon[12]) * 100, 1)} at 12 mo`
                          : 'No 12-month figure stored'}
                      </div>
                    </div>
                  ))}
                </section>
                {coverage.one_sided_available && coverage.one_sided_by_model ? (
                  <>
                    <div style={{ margin: '0 20px 10px', fontSize: 14 }}>
                      The safe production plan uses the upper bound as a buffer against under-production: counted
                      directly from the stored test predictions (n = 15 origins per model and horizon), the actual
                      outcome stayed <b>at or below</b> the upper bound about{' '}
                      <b>
                        {Object.entries(coverage.one_sided_by_model).find(([m]) => /prophet \(defaults\)/i.test(m))
                          ? wholeOutOfTen(
                              coverage.one_sided_by_model[
                                Object.keys(coverage.one_sided_by_model).find((m) => /prophet \(defaults\)/i.test(m))
                              ].by_horizon[1]?.at_or_below_upper
                            )
                          : '—'}
                      </b>{' '}
                      months at a 1-month horizon, and about{' '}
                      <b>
                        {Object.keys(coverage.one_sided_by_model).find((m) => /prophet \(defaults\)/i.test(m))
                          ? wholeOutOfTen(
                              coverage.one_sided_by_model[
                                Object.keys(coverage.one_sided_by_model).find((m) => /prophet \(defaults\)/i.test(m))
                              ].by_horizon[12]?.at_or_below_upper
                            )
                          : '—'}
                      </b>{' '}
                      months at a 12-month horizon, for the deployed model (Prophet, defaults).
                    </div>
                    <div className="table-wrap" style={{ margin: '0 20px 10px' }}>
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Model</th>
                            <th scope="col">At/below upper (1 mo)</th>
                            <th scope="col">At/below upper (12 mo)</th>
                            <th scope="col">At/below upper (avg, all horizons)</th>
                            <th scope="col">Two-sided (avg, all horizons)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(coverage.one_sided_by_model).map(([model, d]) =>
                            d.has_interval ? (
                              <tr key={model}>
                                <td>{model}</td>
                                <td>{d.by_horizon[1] ? pct(d.by_horizon[1].at_or_below_upper * 100, 1) : '—'}</td>
                                <td>{d.by_horizon[12] ? pct(d.by_horizon[12].at_or_below_upper * 100, 1) : '—'}</td>
                                <td>{pct(d.average.at_or_below_upper * 100, 1)}</td>
                                <td>{pct(d.average.two_sided * 100, 1)}</td>
                              </tr>
                            ) : (
                              <tr key={model}>
                                <td>{model}</td>
                                <td colSpan={4}>— (no range)</td>
                              </tr>
                            )
                          )}
                        </tbody>
                      </table>
                    </div>
                    <p style={{ margin: '0 20px 10px', fontSize: 13, color: 'var(--muted)' }}>
                      {noRangeModels.length > 0 && (
                        <>
                          {formatList(noRangeModels)} {noRangeModels.length === 1 ? "doesn't" : "don't"} produce a
                          prediction range, so coverage doesn't apply to {noRangeModels.length === 1 ? 'it' : 'them'} —
                          excluded from every average above.{' '}
                        </>
                      )}
                      SARIMA's ranges are better calibrated than Prophet's on this stored data — both its one-sided
                      and two-sided coverage run closer to their intended rates.
                    </p>
                  </>
                ) : (
                  <div style={{ margin: '0 20px 10px' }}>
                    <NotAvailable what="One-sided coverage" />
                  </div>
                )}
                <p style={{ margin: '0 20px 18px', fontSize: 14 }}>
                  The intended interval width for these figures is {coverage.interval_width != null ? `${coverage.interval_width * 100}%` : '—'}.
                  {coverage.coverage_caveat ? ` ${coverage.coverage_caveat}` : ''}
                </p>
              </>
            ) : (
              <div style={{ margin: '0 20px 18px' }}>
                <NotAvailable what="Coverage results" />
              </div>
            )}
          </section>

          {/* ---------- Where does it go wrong? ---------- */}
          <section className="card" aria-labelledby="seasonTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="seasonTitle">
                  Where does it go wrong?
                </h2>
              </div>
            </div>
            {errorAnalysis ? (
              <div className="chart-wrap">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={seasonChartRows} margin={{ top: 20, right: 20, bottom: 10, left: 10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                    <XAxis dataKey="season" />
                    <YAxis unit="%" />
                    <Tooltip formatter={(v) => (typeof v === 'number' ? `${v.toFixed(2)}%` : v)} />
                    <Legend />
                    {seasonModelNames.map((m) => (
                      <Bar key={m} dataKey={m} fill={colorFor(m, seasonModelNames)} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div style={{ margin: '0 20px 18px' }}>
                <NotAvailable what="Error-by-season results" />
              </div>
            )}
          </section>

          {/* ---------- Was the test fair? ---------- */}
          <section className="card" aria-labelledby="protocolTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="protocolTitle">
                  Was the test fair?
                </h2>
              </div>
            </div>
            {protocol ? (
              <div style={{ margin: '0 20px 18px' }}>
                <p style={{ fontSize: 14 }}>
                  The evaluation protocol below was fixed on <b>{protocol.protocol_date}</b>, before any of these runs —
                  the train/test split, the models compared and the outlier rule were all decided in advance, and the
                  26-month test set was never used to choose or tune any model (hyperparameter tuning used only
                  cross-validation within the training period).
                </p>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left', fontWeight: 600 }}>
                          Training period
                        </th>
                        <td>{protocol.train_period}</td>
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left', fontWeight: 600 }}>
                          Test period
                        </th>
                        <td>{protocol.test_period}</td>
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left', fontWeight: 600 }}>
                          Outlier rule
                        </th>
                        <td>{protocol.outlier_rule}</td>
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left', fontWeight: 600 }}>
                          Models compared
                        </th>
                        <td>{protocol.models_compared.join(', ')}</td>
                      </tr>
                      <tr>
                        <th scope="row" style={{ textAlign: 'left', fontWeight: 600 }}>
                          Chosen SARIMA order
                        </th>
                        <td>
                          {protocol.chosen_sarima_order ? `(${protocol.chosen_sarima_order.join(', ')})` : '—'}
                          {protocol.chosen_sarima_seasonal_order ? ` x (${protocol.chosen_sarima_seasonal_order.join(', ')})` : ''}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div style={{ margin: '0 20px 18px' }}>
                <NotAvailable what="Protocol facts" />
              </div>
            )}
          </section>
            </div>
          </details>

          {provenanceFiles.length > 0 && (
            <footer className="foot">
              <p className="prov">Results read from: {provenanceFiles.join(' · ')}</p>
            </footer>
          )}
        </>
      )}
    </AppLayout>
  );
}

export default ModelEvaluation;
