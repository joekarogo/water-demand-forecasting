import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList, ResponsiveContainer } from 'recharts';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import InfoTip from './components/InfoTip';
import { RetryIcon, ErrorTriangleIcon, InfoIcon, EmptyForecastIcon } from './layout/icons';
import { formatDateNairobi } from './utils/format';
import './App.css';

const API_URL = '/api/model-evaluation';
const TEST_MONTHS = 26;

const ENSEMBLE_KEY = 'Ensemble (50/50)';
const PROPHET_KEY = 'Prophet (defaults)';
const NAIVE_KEY = 'Seasonal-naive';
const GROWTH_KEY = 'Last-year x growth';

const TEAL = '#0d7f80';
const MUTED_BAR = '#7fa9c7';

const ROLLING_HORIZONS_FULL = Array.from({ length: 12 }, (_, i) => i + 1);

const TECHNICAL_DETAILS_HASH = '#technical-details';

function pct(value, digits = 2) {
  return value == null ? '—' : `${Number(value).toFixed(digits)}%`;
}
function isSignificant(pValue) {
  return typeof pValue === 'number' && pValue < 0.05;
}
function dmStatisticCell(value) {
  return value === 'not computable' || value == null ? '—' : Number(value).toFixed(3);
}
function pValueCell(value) {
  if (value === 'not computable' || value == null) return '—';
  if (value < 0.001) return '< 0.001';
  return Number(value).toFixed(3);
}
function verdictCell(value) {
  if (value === 'not computable' || value == null) return '—';
  return isSignificant(value) ? 'Significant' : 'Not significant';
}

// Plain, jargon-free display names for every chart/table on this page.
// The SARIMA label is matched dynamically (via sarima_label, resolved
// server-side from ml/results/sarima_select_chosen.json) rather than
// hard-coded, so this never silently breaks if the chosen SARIMA order
// ever changes.
function buildNameMap(sarimaLabel) {
  const map = {
    [ENSEMBLE_KEY]: 'Ensemble (Prophet + SARIMA) — published',
    [PROPHET_KEY]: 'Prophet',
    [NAIVE_KEY]: 'Same as last year',
    [GROWTH_KEY]: 'Last year × growth',
  };
  if (sarimaLabel) map[sarimaLabel] = 'SARIMA';
  return map;
}
function displayName(map, key) {
  return (map && map[key]) || key;
}

// Exactly 3 plain-language facts, each built strictly from the already-
// loaded sections below — never a separate, independently-invented claim.
// A fact whose precondition data isn't available is simply left out
// rather than guessed, so this card degrades the same way the rest of the
// page does.
function buildSummaryBullets(sections) {
  const ensemble = sections.ensemble;
  const testSet = sections.test_set_metrics;
  const ensembleConformal = sections.ensemble_conformal;
  const bullets = [];

  if (ensemble?.test_metrics && testSet?.models) {
    const sarimaLabel = ensemble.sarima_label;
    const ensembleMape = ensemble.test_metrics[ENSEMBLE_KEY]?.mape;
    const prophetMape = ensemble.test_metrics[PROPHET_KEY]?.mape;
    const sarimaMape = sarimaLabel ? ensemble.test_metrics[sarimaLabel]?.mape : null;
    const naiveMape = testSet.models[NAIVE_KEY]?.mape;
    if (ensembleMape != null && prophetMape != null && sarimaMape != null) {
      const betterThanAll = naiveMape != null && ensembleMape < prophetMape && ensembleMape < sarimaMape && ensembleMape < naiveMape;
      bullets.push(
        `The published forecast averages two models, Prophet and SARIMA. On ${TEST_MONTHS} months it had never seen, ` +
          `it was off by ${ensembleMape.toFixed(1)}% on average` +
          (betterThanAll ? ' — better than either model alone and better than simply repeating last year.' : '.')
      );
    }
  }

  const ensembleByHorizon = ensemble?.rolling_mape_by_horizon?.[ENSEMBLE_KEY];
  if (ensembleByHorizon) {
    const values = Object.values(ensembleByHorizon).filter((v) => typeof v === 'number');
    if (values.length > 0) {
      const lo = Math.round(Math.min(...values));
      const hi = Math.round(Math.max(...values));
      const range = lo === hi ? `${lo}` : `${Math.min(lo, hi)}–${Math.max(lo, hi)}`;
      bullets.push(`It stays about as accurate whether you look 1 month or 12 months ahead: roughly ${range}% average error at every distance.`);
    }
  }

  const ensembleCoverage = ensembleConformal?.ensemble_conformal;
  const avgUpper = ensembleCoverage?.average?.at_or_below_upper_coverage_pct;
  const h12Upper = ensembleCoverage?.by_horizon?.[12]?.at_or_below_upper_coverage_pct;
  if (avgUpper != null && h12Upper != null) {
    const x = Math.round(avgUpper / 10);
    const y = Math.round(h12Upper / 10);
    bullets.push(
      `The top of the likely range held in about ${x} in 10 months (${y} in 10 when looking 12 months ahead), which is why the safe production plan uses it.`
    );
  }

  return bullets;
}

// "How the methods compared" bar data — sorted best (lowest 26-month test
// MAPE) first, live every time, never a fixed order.
function buildComparisonBars(sections, nameMap) {
  const ensemble = sections.ensemble;
  const testSet = sections.test_set_metrics;
  if (!ensemble?.test_metrics || !testSet?.models) return null;
  const sarimaLabel = ensemble.sarima_label;
  const rows = [];
  const add = (key, mape) => {
    if (typeof mape === 'number' && key) rows.push({ key, name: displayName(nameMap, key), mape });
  };
  add(ENSEMBLE_KEY, ensemble.test_metrics[ENSEMBLE_KEY]?.mape);
  add(PROPHET_KEY, ensemble.test_metrics[PROPHET_KEY]?.mape);
  add(sarimaLabel, sarimaLabel ? ensemble.test_metrics[sarimaLabel]?.mape : null);
  add(NAIVE_KEY, testSet.models[NAIVE_KEY]?.mape);
  add(GROWTH_KEY, testSet.models[GROWTH_KEY]?.mape);
  if (rows.length === 0) return null;
  return rows.sort((a, b) => a.mape - b.mape);
}

// "Error by months ahead" — h1-h12 for exactly 5 models (CV-tuned Prophet
// is deliberately left off this page; it's a tuning variant, not part of
// the published-model story).
function buildErrorByHorizonRows(sections) {
  const ensemble = sections.ensemble;
  if (!ensemble?.rolling_mape_by_horizon) return null;
  const order = [ENSEMBLE_KEY, PROPHET_KEY, ensemble.sarima_label, NAIVE_KEY, GROWTH_KEY];
  const rows = order.filter((key) => key && ensemble.rolling_mape_by_horizon[key]).map((key) => ({ key, byHorizon: ensemble.rolling_mape_by_horizon[key] }));
  return rows.length ? rows : null;
}

// "Likely range reliability" — 4 rows, each sourced from an already-
// computed split-conformal (or raw) interval; nothing recomputed here.
function buildLikelyRangeRows(sections) {
  const conformal = sections.conformal;
  const ensembleConformal = sections.ensemble_conformal;
  if (!conformal && !ensembleConformal) return null;
  const rows = [];
  const add = (label, entry) => {
    if (!entry) return;
    rows.push({
      label,
      inside_avg: entry.average?.two_sided_coverage_pct,
      under_top_avg: entry.average?.at_or_below_upper_coverage_pct,
      under_top_1: entry.by_horizon?.[1]?.at_or_below_upper_coverage_pct,
      under_top_12: entry.by_horizon?.[12]?.at_or_below_upper_coverage_pct,
      width_avg: entry.average?.mean_width_pct,
    });
  };
  add('Ensemble (calibrated)', ensembleConformal?.ensemble_conformal);
  add('Prophet (calibrated)', conformal?.prophet_conformal);
  add('Prophet (original range)', conformal?.prophet_raw);
  add('SARIMA', conformal?.sarima);
  return rows.length ? rows : null;
}

// "Are the differences significant?" — the pre-existing Protocol 1 pairs
// plus the two new Ensemble-vs-Prophet/Ensemble-vs-SARIMA pairs, merged
// for display only (no new statistic is computed here).
function buildSignificanceRows(sections) {
  const dm = sections.diebold_mariano;
  const ensemble = sections.ensemble;
  const rows = [];
  if (ensemble?.dm_vs_prophet) {
    Object.keys(ensemble.dm_vs_prophet).forEach((h) => {
      const v = ensemble.dm_vs_prophet[h];
      rows.push({ model_a: ENSEMBLE_KEY, model_b: PROPHET_KEY, horizon: Number(h), n: v.n, dm_statistic: v.dm_statistic, p_value: v.p_value });
    });
  }
  if (ensemble?.dm_vs_sarima && ensemble.sarima_label) {
    Object.keys(ensemble.dm_vs_sarima).forEach((h) => {
      const v = ensemble.dm_vs_sarima[h];
      rows.push({ model_a: ENSEMBLE_KEY, model_b: ensemble.sarima_label, horizon: Number(h), n: v.n, dm_statistic: v.dm_statistic, p_value: v.p_value });
    });
  }
  if (dm?.pairs) rows.push(...dm.pairs);
  return rows.length ? rows : null;
}

// Later of the two "fixed" result files' own run_timestamp — never
// assumed, compared live every time this renders.
function latestRunTimestamp(sections) {
  const a = sections.ensemble?.run_timestamp;
  const b = sections.ensemble_conformal?.run_timestamp;
  if (a && b) return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
  return a || b || null;
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

  const nameMap = buildNameMap(sections.ensemble?.sarima_label);
  const summaryBullets = data ? buildSummaryBullets(sections) : [];
  const comparisonBars = buildComparisonBars(sections, nameMap);
  const errorByHorizonRows = buildErrorByHorizonRows(sections);
  const likelyRangeRows = buildLikelyRangeRows(sections);
  const significanceRows = buildSignificanceRows(sections);
  const otherInputs = sections.other_inputs?.items || null;
  const protocol = sections.protocol;
  const originsCount = sections.rolling_origin?.n_origins_total ?? null;
  const lastEvaluated = latestRunTimestamp(sections);

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

          {summaryBullets.length > 0 && (
            <section className="card" aria-labelledby="summaryTitle">
              <div className="card-head">
                <div>
                  <h2 className="card-title" id="summaryTitle">
                    Performance summary
                  </h2>
                </div>
              </div>
              <ul style={{ margin: '0 20px 18px', paddingLeft: 20, fontSize: 14 }}>
                {summaryBullets.map((fact, i) => (
                  <li key={i} style={{ marginBottom: i < summaryBullets.length - 1 ? 8 : 0 }}>
                    {fact}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card" aria-labelledby="comparisonTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="comparisonTitle">
                  How the methods compared
                </h2>
                <p className="card-sub">Average error on the {TEST_MONTHS} test months (Jul 2022 – Aug 2024) · lower is better</p>
              </div>
            </div>
            {comparisonBars ? (
              <>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={comparisonBars} layout="vertical" margin={{ top: 10, right: 60, bottom: 10, left: 10 }}>
                      <CartesianGrid horizontal={false} stroke="#eef2f6" />
                      <XAxis type="number" unit="%" />
                      <YAxis type="category" dataKey="name" width={230} tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(v) => `${Number(v).toFixed(1)}%`} />
                      <Bar dataKey="mape">
                        <LabelList dataKey="mape" position="right" formatter={(v) => `${Number(v).toFixed(1)}%`} />
                        {comparisonBars.map((b) => (
                          <Cell key={b.key} fill={b.key === ENSEMBLE_KEY ? TEAL : MUTED_BAR} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                {/* Accessible, test-friendly text equivalent of the bar chart above, same sorted order. */}
                <ul className="sr-only">
                  {comparisonBars.map((b) => (
                    <li key={b.key}>
                      {b.name}: {b.mape.toFixed(1)}%
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div style={{ margin: '0 20px 18px' }}>
                <NotAvailable what="Method comparison" />
              </div>
            )}
          </section>

          <details className="disclosure" open={detailsOpen} onToggle={handleDetailsToggle}>
            <summary className="disclosure-summary">Technical details</summary>
            <p className="card-sub" style={{ margin: '4px 20px 12px' }}>
              For reviewers and analysts
            </p>
            <div className="disclosure-content">
              {/* ---------- Error by months ahead ---------- */}
              <section className="card" aria-labelledby="errorByHorizonTitle">
                <div className="card-head">
                  <div>
                    <h2 className="card-title" id="errorByHorizonTitle">
                      Error by months ahead
                    </h2>
                  </div>
                  <InfoTip id="errorByHorizonTip" label="What this table shows">
                    <p>
                      Rolling-origin evaluation repeats the forecast from many different starting points ("origins") in
                      the past, each time checking how accurate it was 1 through 12 months ahead.
                    </p>
                  </InfoTip>
                </div>
                {errorByHorizonRows ? (
                  <>
                    <div className="table-wrap" style={{ margin: '12px 20px' }}>
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Model</th>
                            {ROLLING_HORIZONS_FULL.map((h) => (
                              <th scope="col" key={h}>
                                {h} mo
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {errorByHorizonRows.map((r) => (
                            <tr key={r.key}>
                              <td>{displayName(nameMap, r.key)}</td>
                              {ROLLING_HORIZONS_FULL.map((h) => (
                                <td key={h}>{pct(r.byHorizon[h])}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="table-note" style={{ margin: '0 20px 18px' }}>
                      {originsCount != null ? `${originsCount} forecast start points, Jun 2022 – Aug 2023.` : ''}
                    </p>
                  </>
                ) : (
                  <div style={{ margin: '0 20px 18px' }}>
                    <NotAvailable what="Error-by-horizon results" />
                  </div>
                )}
              </section>

              {/* ---------- Likely range reliability ---------- */}
              <section className="card" aria-labelledby="likelyRangeTitle">
                <div className="card-head">
                  <div>
                    <h2 className="card-title" id="likelyRangeTitle">
                      Likely range reliability
                    </h2>
                  </div>
                  <InfoTip id="likelyRangeTip" label="What these columns mean">
                    <p>
                      <b>Share inside the range</b> is how often actual demand fell inside the band on past data.{' '}
                      <b>Share under its top</b> is the narrower, more operational question the safe production plan
                      actually relies on: how often the actual outcome stayed at or below the top of the range alone.{' '}
                      <b>Width</b> is the band's size as a percentage of the forecast.
                    </p>
                  </InfoTip>
                </div>
                {likelyRangeRows ? (
                  <div className="table-wrap" style={{ margin: '12px 20px 18px' }}>
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Model</th>
                          <th scope="col">Inside the range (avg)</th>
                          <th scope="col">Under the top (1 mo)</th>
                          <th scope="col">Under the top (12 mo)</th>
                          <th scope="col">Under the top (avg)</th>
                          <th scope="col">Width (avg, % of forecast)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {likelyRangeRows.map((r) => (
                          <tr key={r.label}>
                            <td>{r.label}</td>
                            <td>{pct(r.inside_avg, 1)}</td>
                            <td>{pct(r.under_top_1, 1)}</td>
                            <td>{pct(r.under_top_12, 1)}</td>
                            <td>{pct(r.under_top_avg, 1)}</td>
                            <td>{pct(r.width_avg, 1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ margin: '0 20px 18px' }}>
                    <NotAvailable what="Likely range reliability results" />
                  </div>
                )}
              </section>

              {/* ---------- Are the differences significant? ---------- */}
              <section className="card" aria-labelledby="dmTitle">
                <div className="card-head">
                  <div>
                    <h2 className="card-title" id="dmTitle">
                      Are the differences significant?
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
                {significanceRows ? (
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
                          {significanceRows.map((p, i) => (
                            <tr key={i}>
                              <td>{displayName(nameMap, p.model_a)}</td>
                              <td>{displayName(nameMap, p.model_b)}</td>
                              <td>{p.horizon} mo</td>
                              <td>{dmStatisticCell(p.dm_statistic)}</td>
                              <td>{pValueCell(p.p_value)}</td>
                              <td>{verdictCell(p.p_value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p style={{ margin: '0 20px 8px', fontSize: 14 }}>
                      With {TEST_MONTHS} test months, the differences are consistent but not statistically proven.
                    </p>
                    <p className="table-note" style={{ margin: '0 20px 18px' }}>
                      — = not computable (too few non-overlapping pairs at that horizon).
                    </p>
                  </>
                ) : (
                  <div style={{ margin: '0 20px 18px' }}>
                    <NotAvailable what="Significance results" />
                  </div>
                )}
              </section>

              {/* ---------- Other inputs evaluated ---------- */}
              <section className="card" aria-labelledby="otherInputsTitle">
                <div className="card-head">
                  <div>
                    <h2 className="card-title" id="otherInputsTitle">
                      Other inputs evaluated
                    </h2>
                  </div>
                </div>
                {otherInputs ? (
                  <div className="table-wrap" style={{ margin: '12px 20px 18px' }}>
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Input</th>
                          <th scope="col">Test average error</th>
                          <th scope="col">12-months-ahead error</th>
                          <th scope="col">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {otherInputs.map((v) => (
                          <tr key={v.name}>
                            <td>{v.name}</td>
                            <td>{pct(v.test_mape)}</td>
                            <td>{pct(v.h12_mape)}</td>
                            <td>{v.adopted ? 'Adopted' : 'Not adopted'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{ margin: '0 20px 18px' }}>
                    <NotAvailable what="Other-inputs results" />
                  </div>
                )}
              </section>

              {/* ---------- Evaluation protocol ---------- */}
              <section className="card" aria-labelledby="protocolTitle">
                <div className="card-head">
                  <div>
                    <h2 className="card-title" id="protocolTitle">
                      Evaluation protocol
                    </h2>
                  </div>
                </div>
                {protocol ? (
                  <div style={{ margin: '0 20px 18px' }}>
                    <p style={{ fontSize: 14 }}>
                      The evaluation protocol below was fixed on <b>{protocol.protocol_date}</b>, before any of these
                      runs — the train/test split and the outlier rule were decided in advance, and the 26-month test
                      period was never used to choose or tune any model (hyperparameter tuning used only
                      cross-validation within the training period).
                    </p>
                    <p style={{ fontSize: 14 }}>
                      A second round of experiments (calibrated ranges, weather, holiday days and the ensemble) was
                      fixed in writing on 8 November 2026, before any of them were run; the same training and test
                      periods were used.
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

          <footer className="foot">
            <p className="prov">
              Model: {data.published_model_name || 'not available'} · Last evaluated:{' '}
              {lastEvaluated ? formatDateNairobi(lastEvaluated) : '—'} · Test period: Jul 2022 – Aug 2024 ({TEST_MONTHS}{' '}
              months)
            </p>
          </footer>
        </>
      )}
    </AppLayout>
  );
}

export default ModelEvaluation;
