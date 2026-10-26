import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import InfoTip from './components/InfoTip';
import { InfoIcon, RetryIcon, ErrorTriangleIcon, EmptyForecastIcon } from './layout/icons';
import {
  formatMonthShort,
  formatMonthLong,
  formatPublishedDate,
  formatDateLong,
  formatDateShort,
  formatDateTime,
  todayDateString,
  fmtInt,
  fmtMillions,
} from './utils/format';
import './App.css';

const SHOW_NEXT_OPTIONS = [3, 6, 12];
const PLAN_API_URL = '/api/production/plan';
const STOCK_API_URL = '/api/production/stock';

const PLAN_TYPE_LABELS = { normal: 'Normal', safe: 'Safe', custom: 'Custom' };
const REASON_LABELS = {
  planned_maintenance: 'Planned maintenance',
  drought_restrictions: 'Drought restrictions',
  expected_event: 'Expected event',
  supply_constraint: 'Supply constraint',
  other: 'Other',
};
const REASON_OPTIONS = Object.entries(REASON_LABELS);

// Clears one field's stale server-side error as soon as the user edits
// that field, rather than leaving a red border/message that no longer
// reflects what's currently typed.
function clearFieldError(setErrors, field) {
  setErrors((prev) => {
    if (!(field in prev)) return prev;
    const next = { ...prev };
    delete next[field];
    return next;
  });
}

// A thousands-separated amount input, kept as type="text" (not type="number")
// so it can display "62,000,000" while typing. Tracks how many DIGITS (not
// characters) precede the cursor in the pre-edit value, then places the
// cursor after that same count of digits in the reformatted value — so
// inserting/deleting a comma elsewhere never makes the cursor jump.
function handleFormattedAmountChange(e, setValue, setErrors, errorField) {
  const input = e.target;
  const rawValue = input.value;
  const cursorPos = input.selectionStart ?? rawValue.length;
  const digitsBeforeCursor = rawValue.slice(0, cursorPos).replace(/\D/g, '').length;
  const digitsOnly = rawValue.replace(/\D/g, '');
  const formatted = digitsOnly ? Number(digitsOnly).toLocaleString('en-US') : '';

  let newPos = 0;
  if (digitsBeforeCursor > 0) {
    let digitsSeen = 0;
    newPos = formatted.length;
    for (let i = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) {
        digitsSeen++;
        if (digitsSeen === digitsBeforeCursor) {
          newPos = i + 1;
          break;
        }
      }
    }
  }

  // Set the DOM value/selection directly first: React skips redundant DOM
  // writes when the value it's about to set already matches the DOM, so
  // the selection set here survives the re-render instead of being reset
  // to the end of the input.
  input.value = formatted;
  input.setSelectionRange(newPos, newPos);
  setValue(formatted);
  if (errorField) clearFieldError(setErrors, errorField);
}

// "62,000,000" -> 62000000 (NaN if nothing was typed).
function parseFormattedAmount(value) {
  return Number(value.replace(/,/g, ''));
}

// The smallest "nice" step (in millions) that keeps a chart axis spanning
// `rangeM` million m³ to roughly 5-7 ticks — e.g. a ~5M range gets a 1M
// step, a ~10M range gets a 2M step.
function niceStepMillions(rangeM) {
  const rawStep = rangeM / 6 || 1;
  const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  for (const candidate of candidates) {
    if (candidate >= rawStep) return candidate;
  }
  return Math.ceil(rawStep);
}

function ShowNextControl({ options, value, onChange, label, labelId }) {
  const refs = useRef({});

  const handleKeyDown = (e, idx) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const nextIdx = (idx + (e.key === 'ArrowRight' ? 1 : -1) + options.length) % options.length;
    const nextVal = options[nextIdx];
    onChange(nextVal);
    refs.current[nextVal]?.focus();
  };

  return (
    <div className="ctl-group">
      <span className="ctl-label" id={labelId}>
        {label}
      </span>
      <div className="segmented" role="radiogroup" aria-labelledby={labelId}>
        {options.map((opt, idx) => (
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

function StockChangeCell({ changeM3 }) {
  if (changeM3 == null) {
    return <span className="chg-n">—</span>;
  }
  if (changeM3 === 0) {
    return <span className="chg-n">No change</span>;
  }
  const up = changeM3 > 0;
  return (
    <span className={up ? 'chg-up' : 'chg-down'}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      <span className="sr-only">{up ? 'up' : 'down'}</span> {up ? '+' : '−'}
      {fmtMillions(Math.abs(changeM3))}M m³
    </span>
  );
}

function StockTrendTooltip({ active, payload }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const point = payload[0].payload;
  return (
    <div className="chart-tooltip" role="group" aria-label={`${formatDateLong(point.recorded_on)} reading`}>
      <p className="chart-tooltip-label">{formatDateLong(point.recorded_on)}</p>
      <p>
        {fmtInt(point.stock_m3)} m³ ({fmtMillions(point.stock_m3)}M m³)
      </p>
      <p>Recorded by {point.recorded_by}</p>
    </div>
  );
}

function ProductionPlanning() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();

  const [status, setStatus] = useState('loading'); // loading | ready | empty | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [planData, setPlanData] = useState(null);

  const [stockData, setStockData] = useState(null);
  const [stockError, setStockError] = useState(false);
  const [newReadingDate, setNewReadingDate] = useState(null);

  const [showNext, setShowNext] = useState(12);

  const [toast, setToast] = useState('');
  const toastTimerRef = useRef(null);

  const [stockDate, setStockDate] = useState(todayDateString());
  const [stockAmount, setStockAmount] = useState('');
  const [stockFieldErrors, setStockFieldErrors] = useState({});
  const [stockSubmitting, setStockSubmitting] = useState(false);

  const [panelMonthIndex, setPanelMonthIndex] = useState(null);
  const [panelHistory, setPanelHistory] = useState([]);
  const [panelHistoryLoading, setPanelHistoryLoading] = useState(false);
  const [panelPlanType, setPanelPlanType] = useState('normal');
  const [panelCustomAmount, setPanelCustomAmount] = useState('');
  const [panelReason, setPanelReason] = useState('');
  const [panelNote, setPanelNote] = useState('');
  const [panelFieldErrors, setPanelFieldErrors] = useState({});
  const [panelConflict, setPanelConflict] = useState(null); // { message, reference }
  const [panelSubmitting, setPanelSubmitting] = useState(false);
  const panelRef = useRef(null);
  const openerRef = useRef(null);

  const showToast = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(''), 3200);
  }, []);

  const handleAuthError = useCallback(
    (response) => {
      if (response.status === 401) {
        localStorage.removeItem('token');
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

  const fetchPlan = useCallback(async ({ silent } = {}) => {
    if (!silent) setStatus('loading');
    try {
      const response = await apiFetch(PLAN_API_URL);
      if (handleAuthError(response)) return undefined;
      if (response.status === 403) {
        setStatus('forbidden');
        return undefined;
      }
      if (response.status === 404) {
        setStatus('empty');
        return undefined;
      }
      const body = await response.json();
      if (!response.ok) {
        setErrorReference(body.reference || null);
        setStatus('error');
        return undefined;
      }
      setPlanData(body);
      setStatus('ready');
      return body;
    } catch (err) {
      setErrorReference(null);
      setStatus('error');
      return undefined;
    }
  }, [handleAuthError]);

  const fetchStock = useCallback(async () => {
    setStockError(false);
    try {
      const response = await apiFetch(STOCK_API_URL);
      if (handleAuthError(response)) return;
      if (!response.ok) {
        setStockError(true);
        return;
      }
      const body = await response.json();
      setStockData(body);
    } catch (err) {
      setStockError(true);
    }
  }, [handleAuthError]);

  useEffect(() => {
    if (sessionLoading || !session) return;
    fetchPlan();
  }, [sessionLoading, session, fetchPlan]);

  useEffect(() => {
    if (status === 'ready' || status === 'empty') {
      fetchStock();
    }
  }, [status, fetchStock]);

  const computed = useMemo(() => {
    if (!planData) return null;
    const months = planData.months;
    const plannedCount = months.filter((m) => m.plan).length;
    const nextUnplannedIndex = months.findIndex((m) => !m.plan);
    const monthRange = `${formatMonthShort(months[0].month)} – ${formatMonthShort(months[months.length - 1].month)}`;
    const visibleMonths = months.slice(0, showNext);
    const forecastValues = months.map((m) => m.forecast_m3);
    const maxForecast = Math.max(...forecastValues);
    const minForecast = Math.min(...forecastValues);

    return { months, plannedCount, nextUnplannedIndex, monthRange, visibleMonths, maxForecast, minForecast };
  }, [planData, showNext]);

  const prefillPanelFromMonth = (monthObj) => {
    const plan = monthObj.plan;
    setPanelPlanType(plan ? plan.plan_type : 'normal');
    setPanelCustomAmount(plan && plan.plan_type === 'custom' ? plan.chosen_m3.toLocaleString('en-US') : '');
    setPanelReason(plan && plan.plan_type === 'custom' ? plan.reason || '' : '');
    setPanelNote(plan && plan.plan_type === 'custom' ? plan.note || '' : '');
  };

  const openPanel = useCallback(
    (index, openerEl) => {
      if (!computed) return;
      openerRef.current = openerEl || document.activeElement;
      setPanelMonthIndex(index);
      setPanelConflict(null);
      setPanelFieldErrors({});

      const month = computed.months[index];
      prefillPanelFromMonth(month);

      setPanelHistory([]);
      setPanelHistoryLoading(true);
      apiFetch(`${PLAN_API_URL}/${month.month}/history`)
        .then(async (response) => {
          if (handleAuthError(response)) return;
          if (!response.ok) return;
          const body = await response.json();
          setPanelHistory(body.history || []);
        })
        .catch(() => {})
        .finally(() => setPanelHistoryLoading(false));
    },
    [computed, handleAuthError]
  );

  const closePanel = useCallback(() => {
    setPanelMonthIndex(null);
    setPanelConflict(null);
    if (openerRef.current && document.body.contains(openerRef.current)) {
      openerRef.current.focus();
    }
  }, []);

  useEffect(() => {
    if (panelMonthIndex === null) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        closePanel();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = [...panelRef.current.querySelectorAll('button, input, select, textarea')].filter(
          (el) => !el.disabled && el.offsetParent !== null
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [panelMonthIndex, closePanel]);

  useEffect(() => {
    if (panelMonthIndex === null || !panelRef.current) return;
    const checkedRadio = panelRef.current.querySelector('input[name="plan_type"]:checked');
    (checkedRadio || panelRef.current.querySelector('.icon-btn'))?.focus();
  }, [panelMonthIndex]);

  const customAmountWarning = useMemo(() => {
    if (panelPlanType !== 'custom' || panelMonthIndex === null || !computed) return null;
    const v = parseFormattedAmount(panelCustomAmount);
    if (!(v > 0)) return null;
    const month = computed.months[panelMonthIndex];
    if (v < month.normal_m3) {
      return {
        kind: 'danger',
        text: `Below expected demand: risk of shortfall (normal plan is ${fmtMillions(month.normal_m3)}M m³).`,
      };
    }
    if (v > month.safe_m3 * 1.1) {
      return {
        kind: 'amber',
        text: `Above the safe plan: possible over-production (safe plan is ${fmtMillions(month.safe_m3)}M m³).`,
      };
    }
    return null;
  }, [panelPlanType, panelCustomAmount, panelMonthIndex, computed]);

  const handleReloadConflict = async () => {
    const freshData = await fetchPlan();
    setPanelConflict(null);
    if (freshData && panelMonthIndex !== null) {
      prefillPanelFromMonth(freshData.months[panelMonthIndex]);
    }
  };

  const handleSavePlan = async (e) => {
    e.preventDefault();
    if (panelMonthIndex === null || !computed || !planData) return;
    const month = computed.months[panelMonthIndex];
    const plan = month.plan;
    const expectedVersion = plan ? plan.version : 0;

    const body = {
      forecast_id: planData.forecast_id,
      month: month.month,
      plan_type: panelPlanType,
      expected_version: expectedVersion,
    };
    if (panelPlanType === 'custom') {
      body.custom_m3 = parseFormattedAmount(panelCustomAmount);
      body.reason = panelReason;
      body.note = panelNote;
    } else if (panelNote.trim()) {
      body.note = panelNote.trim();
    }

    setPanelSubmitting(true);
    setPanelFieldErrors({});
    setPanelConflict(null);
    try {
      const response = await apiFetch(PLAN_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (handleAuthError(response)) return;
      const responseBody = await response.json().catch(() => ({}));

      if (response.status === 409) {
        setPanelConflict({ message: responseBody.error });
        return;
      }
      if (response.status === 400) {
        setPanelFieldErrors(responseBody.fields || {});
        return;
      }
      if (!response.ok) {
        setPanelConflict({
          message: responseBody.error || 'Unable to save the plan right now.',
          reference: responseBody.reference,
        });
        return;
      }

      showToast(`Plan for ${formatMonthShort(month.month)} saved`);
      closePanel();
      // Silent: a plan change can shift days_of_cover (it depends on the
      // first month's plan), but the panel just closed on a success toast —
      // flashing the full loading skeleton over the page right after would
      // be jarring, not an improvement.
      fetchPlan({ silent: true });
    } catch (err) {
      setPanelConflict({ message: 'Unable to reach the server. Please try again.' });
    } finally {
      setPanelSubmitting(false);
    }
  };

  const handleSaveStock = async (e) => {
    e.preventDefault();
    setStockSubmitting(true);
    setStockFieldErrors({});
    const amount = parseFormattedAmount(stockAmount);
    try {
      const response = await apiFetch(STOCK_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recorded_on: stockDate, stock_m3: amount }),
      });
      if (handleAuthError(response)) return;
      const body = await response.json().catch(() => ({}));

      if (response.status === 400) {
        setStockFieldErrors(body.fields || {});
        return;
      }
      if (!response.ok) {
        setStockFieldErrors({ stock_m3: body.error || 'Unable to save this reading right now.' });
        return;
      }

      setNewReadingDate(stockDate);
      showToast(`Reading of ${fmtMillions(amount)}M m³ saved for ${formatDateLong(stockDate)}`);
      setStockAmount('');
      // The "Stored water" and "Days of supply" KPIs come from
      // GET /api/production/plan (latest_stock, days_of_cover), not from
      // the stock list — both must be refetched, silently (no full-page
      // loading skeleton), alongside the stock list itself.
      fetchStock();
      fetchPlan({ silent: true });
    } catch (err) {
      setStockFieldErrors({ stock_m3: 'Unable to reach the server. Please try again.' });
    } finally {
      setStockSubmitting(false);
    }
  };

  const stockTrendPoints = useMemo(() => {
    if (!stockData) return [];
    return [...stockData.data].reverse(); // ascending by date for the chart
  }, [stockData]);

  const stockYAxis = useMemo(() => {
    if (stockTrendPoints.length === 0) {
      return { domain: [0, undefined], ticks: undefined };
    }
    const valuesM = stockTrendPoints.map((p) => p.stock_m3 / 1_000_000);
    const minM = Math.min(...valuesM);
    const maxM = Math.max(...valuesM);
    const step = niceStepMillions(maxM - minM);
    // Padded by one whole step on each side, so the line never touches the
    // plot's top/bottom edge, and rounded to that step so every tick lands
    // on a clean, evenly-spaced value (e.g. 1M or 2M apart) instead of
    // wherever the raw min/max happen to fall.
    const domainMinM = Math.max(0, Math.floor(minM / step) * step - step);
    const domainMaxM = Math.ceil(maxM / step) * step + step;

    const ticks = [];
    for (let t = domainMinM; t <= domainMaxM + 1e-9; t += step) {
      ticks.push(Math.round(t * 1_000_000));
    }
    return { domain: [domainMinM * 1_000_000, domainMaxM * 1_000_000], ticks };
  }, [stockTrendPoints]);

  if (sessionLoading || !session) {
    return null;
  }

  const subtitle = 'Plan monthly water production from the published forecast';
  const extraLines =
    status === 'ready' && planData ? (
      <p className="published">
        <span className="dot" aria-hidden="true" />
        <span>
          Based on forecast published <b>{formatPublishedDate(planData.published_at)}</b> · latest available data:{' '}
          <b>{formatMonthLong(planData.data_up_to)}</b>
        </span>
      </p>
    ) : null;

  const otherPanelErrors = Object.entries(panelFieldErrors).filter(
    ([k]) => !['custom_m3', 'reason', 'note'].includes(k)
  );

  return (
    <AppLayout title="Production Planning" subtitle={subtitle} extraLines={extraLines}>
      {status === 'loading' && (
        <>
          <div className="state-banner" role="status" aria-live="polite">
            <span className="state-banner-spinner" aria-hidden="true" />
            <div>Loading production plan…</div>
          </div>
          <section className="kpis" aria-hidden="true">
            {[55, 60, 45, 50].map((w, i) => (
              <div className="card sk-kpi" key={i}>
                <div className="sk" style={{ width: `${w}%`, height: 12 }} />
                <div className="sk" style={{ width: '60%', height: 28 }} />
                <div className="sk" style={{ width: '80%', height: 10 }} />
              </div>
            ))}
          </section>
          <div className="sk" style={{ height: 46, borderRadius: 8 }} aria-hidden="true" />
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
          <h2>The production plan couldn't be loaded.</h2>
          <p>
            Try again in a moment.
            {errorReference
              ? ` If it keeps happening, tell your system administrator (reference ${errorReference}).`
              : ' If it keeps happening, tell your system administrator.'}
          </p>
          <button className="btn btn-primary" type="button" style={{ marginTop: 8 }} onClick={fetchPlan}>
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
          <h2>You don't have permission to view production planning.</h2>
        </section>
      )}

      {status === 'empty' && (
        <section className="card error-card" role="status">
          <span className="empty-icon" aria-hidden="true">
            <EmptyForecastIcon />
          </span>
          <h2>No forecast published</h2>
          <p>No forecast has been published yet. Ask your administrator to publish one.</p>
          <span className="meta">You can still record stored water readings below. Monthly plans need a published forecast.</span>
        </section>
      )}

      {status === 'ready' && planData && computed && (
        <>
          <section className="kpis" aria-label="Key figures">
            <article className="card kpi accent">
              <div className="kpi-label">Months planned</div>
              <div className="kpi-value">
                {computed.plannedCount}
                <span className="unit of">of 12</span>
              </div>
              <div className="kpi-help">{computed.monthRange}</div>
            </article>

            <article className="card kpi">
              <div className="kpi-label">Next unplanned month</div>
              {computed.nextUnplannedIndex === -1 ? (
                <>
                  <div className="kpi-value">None</div>
                  <div className="kpi-help">all 12 months are planned</div>
                </>
              ) : (
                <>
                  <div className="kpi-value">
                    {formatMonthShort(computed.months[computed.nextUnplannedIndex].month)}
                  </div>
                  <div className="kpi-help">
                    forecast {fmtMillions(computed.months[computed.nextUnplannedIndex].forecast_m3)}M m³ ·{' '}
                    <button
                      type="button"
                      className="kpi-link"
                      onClick={(e) => openPanel(computed.nextUnplannedIndex, e.currentTarget)}
                    >
                      Plan it
                    </button>
                  </div>
                </>
              )}
            </article>

            <article className="card kpi">
              <div className="kpi-label">
                Stored water
                <InfoTip id="tipStock" label="What is stored water?">
                  Usable water in the dams (raw water available for production), as last recorded by the production
                  team. In a live deployment this would come from dam telemetry or İZSU's published dam levels.
                </InfoTip>
              </div>
              {planData.latest_stock ? (
                <>
                  <div className="kpi-value">
                    {fmtMillions(planData.latest_stock.stock_m3)}
                    <span className="unit">M m³</span>
                  </div>
                  <div className="kpi-help">recorded {formatDateLong(planData.latest_stock.recorded_on)}</div>
                </>
              ) : (
                <>
                  <div className="kpi-value">—</div>
                  <div className="kpi-help">No reading yet</div>
                </>
              )}
            </article>

            <article className="card kpi">
              <div className="kpi-label">
                Days of supply
                <InfoTip id="tipCover" label="What does days of supply mean?" align="right">
                  Stored water ÷ daily planned production for {formatMonthLong(computed.months[0].month)}. The
                  published forecast starts after the latest available data ({formatMonthLong(planData.data_up_to)}
                  ), so the planned rate is from {formatMonthLong(computed.months[0].month)}, the first forecast
                  month, not the current month.
                </InfoTip>
              </div>
              {planData.days_of_cover != null ? (
                <>
                  <div className="kpi-value">
                    ≈ {planData.days_of_cover}
                    <span className="unit">days</span>
                  </div>
                  <div className="kpi-help">at the {formatMonthShort(computed.months[0].month)} planned rate</div>
                </>
              ) : (
                <>
                  <div className="kpi-value">—</div>
                  <div className="kpi-help">
                    Needs a stored-water reading and a {formatMonthShort(computed.months[0].month)} plan
                  </div>
                </>
              )}
            </article>
          </section>

          <section className="explain" aria-label="How the plans work">
            <InfoIcon />
            <p style={{ margin: 0 }}>
              <b>Normal plan</b> covers expected demand. <b>Safe plan</b> uses the upper end of the forecast range:
              in past testing, demand stayed below it in about 9 of 10 months (about 8 of 10 for months furthest
              ahead). Both include a {(planData.loss_rate * 100).toFixed(1)}% allowance for non-revenue water.
              <InfoTip id="tipCalc" label="How is this calculated?">
                <b>How is this calculated?</b>
                <br />
                Normal = forecast ÷ (1 − {planData.loss_rate.toFixed(3)}).
                <br />
                Safe = upper end of the 80% range ÷ (1 − {planData.loss_rate.toFixed(3)}).
                <br />
                Source: {planData.loss_rate_source}.
              </InfoTip>
            </p>
          </section>

          <section className="card" aria-labelledby="ppGridTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="ppGridTitle">
                  Monthly production plan
                </h2>
                <p className="card-sub">Next {showNext} months · select a month to plan it</p>
              </div>
              <div className="grid-summary" aria-live="polite">
                <span>
                  <i className="sw teal" aria-hidden="true" />
                  {computed.plannedCount} planned
                </span>
                <span>
                  <i className="sw" aria-hidden="true" />
                  {12 - computed.plannedCount} not planned
                </span>
              </div>
            </div>
            <div className="controls" role="group" aria-label="Grid options">
              <ShowNextControl
                options={SHOW_NEXT_OPTIONS}
                value={showNext}
                onChange={setShowNext}
                label="Show next"
                labelId="ppHorizonLabel"
              />
            </div>
            <div className="spark-wrap">
              <p className="spark-cap">Forecast demand by month · ✓ = planned</p>
              <div className="spark" role="group" aria-label="Forecast demand by month. Select a bar to plan that month.">
                {computed.months.map((m, i) => {
                  const range = computed.maxForecast - computed.minForecast || 1;
                  const pct = 18 + ((m.forecast_m3 - computed.minForecast) / range) * 82;
                  const barHeight = pct * 0.72;
                  const isOut = i >= showNext;
                  const cls = `col${m.plan ? ' planned' : ''}${isOut ? ' out' : ''}`;
                  return (
                    <button
                      key={m.month}
                      type="button"
                      className={cls}
                      tabIndex={isOut ? -1 : 0}
                      aria-label={`${formatMonthShort(m.month)}: forecast ${fmtMillions(m.forecast_m3)} m³, ${
                        m.plan ? 'planned' : 'not planned'
                      }`}
                      onClick={(e) => !isOut && openPanel(i, e.currentTarget)}
                    >
                      <span className="bar" style={{ height: `${barHeight}%` }} />
                      <span className="lbl">{formatMonthShort(m.month).slice(0, 3)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="table-wrap">
              <table className="plan-table">
                <caption className="sr-only">Monthly production plan. Select a month to open its plan.</caption>
                <thead>
                  <tr>
                    <th scope="col">Month</th>
                    <th scope="col">Forecast demand (m³)</th>
                    <th scope="col">Normal plan (m³)</th>
                    <th scope="col">Safe plan (m³)</th>
                    <th scope="col">Chosen plan (m³)</th>
                    <th scope="col" className="l">
                      Plan type
                    </th>
                    <th scope="col" className="l">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {computed.visibleMonths.map((m, i) => {
                    const plan = m.plan;
                    return (
                      <tr key={m.month} onClick={() => openPanel(i, null)}>
                        <td>
                          <button
                            type="button"
                            className="row-btn"
                            aria-label={`${plan ? 'Edit' : 'Plan'} ${formatMonthShort(m.month)}`}
                            aria-haspopup="dialog"
                          >
                            {formatMonthShort(m.month)}
                          </button>
                          {i === computed.nextUnplannedIndex && <span className="tag-next">Next</span>}
                        </td>
                        <td>{fmtMillions(m.forecast_m3)}</td>
                        <td>{fmtMillions(m.normal_m3)}</td>
                        <td>{fmtMillions(m.safe_m3)}</td>
                        {plan ? (
                          <td>
                            <b>{fmtMillions(plan.chosen_m3)}</b>
                          </td>
                        ) : (
                          <td className="dash">—</td>
                        )}
                        {plan ? (
                          <td className="l">
                            {PLAN_TYPE_LABELS[plan.plan_type]}
                            {plan.below_expected && (
                              <span className="warn-pill">
                                <span aria-hidden="true">⚠</span> Below expected demand
                              </span>
                            )}
                          </td>
                        ) : (
                          <td className="l dash">—</td>
                        )}
                        <td className="l">
                          {plan ? (
                            <span className="badge ok">
                              <span aria-hidden="true">✓</span> Planned
                            </span>
                          ) : (
                            <span className="badge none">
                              <span aria-hidden="true">○</span> Not planned
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="table-note">
              Values in millions of m³. Chosen plan is the amount the production team will produce that month.
            </div>
          </section>
        </>
      )}

      {(status === 'ready' || status === 'empty') && (
        <section className="card" id="stockCard" aria-labelledby="stockTitle">
          <div className="card-head">
            <div>
              <h2 className="card-title" id="stockTitle">
                Stored water
              </h2>
              <p className="card-sub">Usable water in the dams</p>
            </div>
          </div>
          <div className="stock-top">
            <h3 className="mini-title">Record a reading</h3>
            <form className="stock-form" onSubmit={handleSaveStock}>
              <div className="field">
                <label htmlFor="stockDate">Date</label>
                <input
                  className="input"
                  type="date"
                  id="stockDate"
                  value={stockDate}
                  max={todayDateString()}
                  aria-invalid={stockFieldErrors.recorded_on ? 'true' : 'false'}
                  onChange={(e) => {
                    setStockDate(e.target.value);
                    clearFieldError(setStockFieldErrors, 'recorded_on');
                  }}
                />
                {stockFieldErrors.recorded_on && <span className="field-err">{stockFieldErrors.recorded_on}</span>}
              </div>
              <div className="field">
                <label htmlFor="stockAmt">Amount (m³)</label>
                <div className="input-suffix">
                  <input
                    className="input"
                    type="text"
                    id="stockAmt"
                    inputMode="numeric"
                    placeholder="e.g. 61,500,000"
                    value={stockAmount}
                    aria-invalid={stockFieldErrors.stock_m3 ? 'true' : 'false'}
                    onChange={(e) => handleFormattedAmountChange(e, setStockAmount, setStockFieldErrors, 'stock_m3')}
                  />
                  <span aria-hidden="true">m³</span>
                </div>
                {parseFormattedAmount(stockAmount) > 0 && (
                  <span className="preview">= {fmtMillions(parseFormattedAmount(stockAmount))} million m³</span>
                )}
                {stockFieldErrors.stock_m3 ? (
                  <span className="field-err">{stockFieldErrors.stock_m3}</span>
                ) : (
                  <span className="field-hint">Whole cubic metres</span>
                )}
              </div>
              <div className="field">
                <span className="btn-spacer" aria-hidden="true" />
                <button
                  className="btn btn-primary"
                  type="submit"
                  style={{ height: 38, justifyContent: 'center' }}
                  disabled={stockSubmitting}
                >
                  {stockSubmitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
          <div className="stock-body">
            <div>
              <h3 className="mini-title">Stored water over time</h3>
              <p className="mini-sub">Last {stockData?.window_days ?? 90} days · millions of m³</p>
              {stockTrendPoints.length >= 2 ? (
                <div className="stock-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={stockTrendPoints} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#eef2f6" />
                      <XAxis
                        dataKey="recorded_on"
                        tickFormatter={formatDateShort}
                        tick={{ fontSize: 11, fill: '#475569' }}
                        minTickGap={24}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: '#475569' }}
                        tickFormatter={(v) => `${Math.round(v / 1_000_000)}M`}
                        domain={stockYAxis.domain}
                        ticks={stockYAxis.ticks}
                        allowDataOverflow
                      />
                      <Tooltip content={<StockTrendTooltip />} />
                      <Line
                        type="monotone"
                        dataKey="stock_m3"
                        stroke="#0b5c8f"
                        strokeWidth={2.5}
                        dot={{ r: 3 }}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <p className="chart-empty">Record at least two readings to see the trend</p>
              )}
            </div>
            <div>
              <h3 className="mini-title">Recent readings</h3>
              <p className="mini-sub">Latest 5 · change is from the previous reading</p>
              <div className="table-wrap" style={{ padding: 0 }}>
                <table className="readings">
                  <caption className="sr-only">Latest 5 stored water readings</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Amount (m³)</th>
                      <th scope="col">Change</th>
                      <th scope="col">Recorded by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(stockData?.data || []).length === 0 ? (
                      <tr>
                        <td colSpan={4} className="dash">
                          No readings recorded yet
                        </td>
                      </tr>
                    ) : (
                      (stockData?.data || []).slice(0, 5).map((r) => (
                        <tr key={r.recorded_on}>
                          <td>
                            <span className="d-date">{formatDateLong(r.recorded_on)}</span>
                            {r.recorded_on === newReadingDate && <span className="new-tag">New</span>}
                          </td>
                          <td>
                            {fmtInt(r.stock_m3)}
                            <span className="ph" aria-hidden="true">
                              {' '}
                              m³
                            </span>
                          </td>
                          <td>
                            <StockChangeCell changeM3={r.change_m3} />
                          </td>
                          <td>
                            <span className="ph" aria-hidden="true">
                              by{' '}
                            </span>
                            {r.recorded_by}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {stockError && <p className="chart-empty" style={{ marginTop: 10 }}>Unable to load stock readings right now.</p>}
            </div>
          </div>
        </section>
      )}

      {panelMonthIndex !== null && computed && (
        <>
          <div className="panel-scrim" onClick={closePanel} />
          <aside
            className="panel open"
            role="dialog"
            aria-modal="true"
            aria-labelledby="panelTitle"
            ref={panelRef}
          >
            {(() => {
              const month = computed.months[panelMonthIndex];
              const plan = month.plan;
              return (
                <>
                  <div className="panel-head">
                    <div>
                      <p className="kicker">Production plan</p>
                      <h2 id="panelTitle">Plan for {formatMonthShort(month.month)}</h2>
                    </div>
                    <button type="button" className="icon-btn" aria-label="Close panel" onClick={closePanel}>
                      ✕
                    </button>
                  </div>
                  <form className="panel-body" id="planForm" onSubmit={handleSavePlan}>
                    <div className="fc-box">
                      <div className="lab">Forecast demand</div>
                      <div className="val">
                        {fmtMillions(month.forecast_m3)}
                        <span className="unit">M m³</span>
                      </div>
                      <div className="rng">
                        80% range {fmtMillions(month.lower_m3)}M – {fmtMillions(month.upper_m3)}M m³
                      </div>
                    </div>

                    {plan && (
                      <div className="current">
                        Current plan:{' '}
                        <b>
                          {PLAN_TYPE_LABELS[plan.plan_type]} · {fmtMillions(plan.chosen_m3)}M m³
                        </b>{' '}
                        · saved {formatDateTime(plan.created_at)} by {plan.created_by}
                      </div>
                    )}

                    <fieldset>
                      <legend>Choose a plan</legend>
                      <div className="choices">
                        <label className="choice">
                          <input
                            type="radio"
                            name="plan_type"
                            value="normal"
                            checked={panelPlanType === 'normal'}
                            onChange={() => {
                              setPanelPlanType('normal');
                              setPanelFieldErrors({});
                            }}
                          />
                          <span className="choice-main">
                            <span className="t">
                              <span>Normal</span>
                              <span className="amt">{fmtMillions(month.normal_m3)}M m³</span>
                            </span>
                            <span className="d">covers expected demand</span>
                          </span>
                        </label>
                        <label className="choice">
                          <input
                            type="radio"
                            name="plan_type"
                            value="safe"
                            checked={panelPlanType === 'safe'}
                            onChange={() => {
                              setPanelPlanType('safe');
                              setPanelFieldErrors({});
                            }}
                          />
                          <span className="choice-main">
                            <span className="t">
                              <span>Safe</span>
                              <span className="amt">{fmtMillions(month.safe_m3)}M m³</span>
                            </span>
                            <span className="d">demand stayed below this in about 9 of 10 months in past testing</span>
                          </span>
                        </label>
                        <label className="choice">
                          <input
                            type="radio"
                            name="plan_type"
                            value="custom"
                            checked={panelPlanType === 'custom'}
                            onChange={() => {
                              setPanelPlanType('custom');
                              setPanelFieldErrors({});
                            }}
                          />
                          <span className="choice-main">
                            <span className="t">
                              <span>Custom</span>
                              <span className="amt">
                                {panelPlanType === 'custom' && parseFormattedAmount(panelCustomAmount) > 0
                                  ? `${fmtMillions(parseFormattedAmount(panelCustomAmount))}M m³`
                                  : ''}
                              </span>
                            </span>
                            <span className="d">set your own amount, with a reason</span>
                          </span>
                        </label>
                      </div>
                    </fieldset>

                    {panelPlanType === 'custom' ? (
                      <div className="custom-fields">
                        <div className="field">
                          <label htmlFor="cAmt">
                            Custom amount (m³)<span className="sr-only"> required</span>
                          </label>
                          <div className="input-suffix">
                            <input
                              className="input"
                              type="text"
                              id="cAmt"
                              inputMode="numeric"
                              placeholder="e.g. 29,000,000"
                              value={panelCustomAmount}
                              aria-invalid={panelFieldErrors.custom_m3 ? 'true' : 'false'}
                              onChange={(e) =>
                                handleFormattedAmountChange(e, setPanelCustomAmount, setPanelFieldErrors, 'custom_m3')
                              }
                            />
                            <span aria-hidden="true">m³</span>
                          </div>
                          {parseFormattedAmount(panelCustomAmount) > 0 && (
                            <span className="preview">= {fmtMillions(parseFormattedAmount(panelCustomAmount))} million m³</span>
                          )}
                          {panelFieldErrors.custom_m3 && <span className="field-err">{panelFieldErrors.custom_m3}</span>}
                          {customAmountWarning && (
                            <div className={`alert ${customAmountWarning.kind}`}>
                              <span aria-hidden="true">{customAmountWarning.kind === 'danger' ? '⚠' : '▲'}</span>
                              <span>{customAmountWarning.text}</span>
                            </div>
                          )}
                        </div>
                        <div className="field">
                          <label htmlFor="cReason">
                            Reason<span className="sr-only"> required</span>
                          </label>
                          <select
                            className="input"
                            id="cReason"
                            value={panelReason}
                            aria-invalid={panelFieldErrors.reason ? 'true' : 'false'}
                            onChange={(e) => {
                              setPanelReason(e.target.value);
                              clearFieldError(setPanelFieldErrors, 'reason');
                            }}
                          >
                            <option value="">Choose a reason…</option>
                            {REASON_OPTIONS.map(([code, label]) => (
                              <option key={code} value={code}>
                                {label}
                              </option>
                            ))}
                          </select>
                          {panelFieldErrors.reason && <span className="field-err">{panelFieldErrors.reason}</span>}
                        </div>
                        <div className="field">
                          <label htmlFor="cNote">
                            Note<span className="sr-only"> required</span>
                          </label>
                          <textarea
                            className="input"
                            id="cNote"
                            rows={3}
                            placeholder="What is the plan based on? e.g. which works, dates, restrictions"
                            value={panelNote}
                            aria-invalid={panelFieldErrors.note ? 'true' : 'false'}
                            onChange={(e) => {
                              setPanelNote(e.target.value);
                              clearFieldError(setPanelFieldErrors, 'note');
                            }}
                          />
                          {panelFieldErrors.note && <span className="field-err">{panelFieldErrors.note}</span>}
                        </div>
                      </div>
                    ) : (
                      <div className="field">
                        <label htmlFor="pNote">Note (optional)</label>
                        <textarea
                          className="input"
                          id="pNote"
                          rows={2}
                          value={panelNote}
                          aria-invalid={panelFieldErrors.note ? 'true' : 'false'}
                          onChange={(e) => {
                            setPanelNote(e.target.value);
                            clearFieldError(setPanelFieldErrors, 'note');
                          }}
                        />
                        {panelFieldErrors.note && <span className="field-err">{panelFieldErrors.note}</span>}
                      </div>
                    )}

                    {otherPanelErrors.map(([k, msg]) => (
                      <div className="alert danger" key={k}>
                        <span aria-hidden="true">⚠</span>
                        <span>{msg}</span>
                      </div>
                    ))}

                    {panelConflict && (
                      <div className="alert danger" aria-live="polite">
                        <span aria-hidden="true">⚠</span>
                        <span>
                          {panelConflict.message}
                          {panelConflict.reference && ` (reference ${panelConflict.reference})`}{' '}
                          <button type="button" className="kpi-link" onClick={handleReloadConflict}>
                            Reload
                          </button>
                        </span>
                      </div>
                    )}

                    <section className="history" aria-labelledby="histTitle">
                      <h3 id="histTitle">Plan history</h3>
                      {panelHistoryLoading ? (
                        <p className="hist-empty">Loading…</p>
                      ) : panelHistory.length === 0 ? (
                        <p className="hist-empty">No plans saved for this month yet.</p>
                      ) : (
                        <ol className="hist">
                          {panelHistory.map((v, k) => (
                            <li key={v.plan_id} className={k === 0 ? 'cur' : ''}>
                              <div className="h1">
                                {PLAN_TYPE_LABELS[v.plan_type]} · {fmtMillions(v.chosen_m3)}M m³
                                {k === 0 && <span className="cur-tag">Current</span>}
                              </div>
                              <div className="meta">
                                {formatDateTime(v.created_at)} · {v.created_by}
                              </div>
                              <div className="why">
                                Reason: {v.reason ? `${REASON_LABELS[v.reason] || v.reason}${v.note ? ' — ' + v.note : ''}` : '—'}
                              </div>
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  </form>
                  <div className="panel-foot">
                    <button type="button" className="btn" onClick={closePanel}>
                      Cancel
                    </button>
                    <button type="submit" form="planForm" className="btn btn-primary" disabled={panelSubmitting}>
                      {panelSubmitting ? 'Saving…' : 'Save plan'}
                    </button>
                  </div>
                </>
              );
            })()}
          </aside>
        </>
      )}

      {toast && (
        <div className="toast show" role="status" aria-live="polite">
          <span className="tick" aria-hidden="true">
            ✓
          </span>
          <span>{toast}</span>
        </div>
      )}
    </AppLayout>
  );
}

export default ProductionPlanning;
