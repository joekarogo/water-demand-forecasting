import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ComposedChart, Bar, Area, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ResponsiveContainer } from 'recharts';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import InfoTip from './components/InfoTip';
import { useViewportWidth } from './utils/useViewportWidth';
import { RetryIcon, ErrorTriangleIcon, EmptyForecastIcon, DownloadIcon, DropOutlineIcon } from './layout/icons';
import {
  formatMonthShort,
  formatMonthShortYY,
  formatMonthLong,
  formatPublishedDate,
  formatDateLong,
  monthName,
  fmtInt,
  fmtTRY,
  fmtTRYMillions,
  fmtTRYPerM3,
} from './utils/format';
import './App.css';

const API_URL = '/api/revenue';

// consumption_detail's customer_group values, with the English gloss the
// brief specifies — Turkish name shown first since that's what the
// source data and the rest of the app use, the gloss alongside it.
const GROUP_GLOSS = {
  Konut: 'Housing',
  'Konut Dışı': 'Non-residential',
  Sanayi: 'Industry',
  Sulama: 'Irrigation',
  'Tarım Hayvan': 'Agriculture and livestock',
};
function groupLabel(group) {
  const gloss = GROUP_GLOSS[group];
  return gloss ? `${group} — ${gloss}` : group;
}

const NOT_PRICED_REASON_LABELS = {
  unmapped: 'no tariff mapping for this subscriber type',
  ambiguous: 'ambiguous tariff in the source data',
  no_subscribers: 'no subscriber count for this cell',
};

const TARIFF_TYPE_LABELS = {
  'KONUT ABONELERİ': 'Housing (KONUT ABONELERİ)',
  'İŞYERİ ABONELERİ': 'Workplace (İŞYERİ ABONELERİ)',
};

const GROUP_COLUMNS = [
  { key: 'customer_group', label: 'Customer group' },
  { key: 'subscribers', label: 'Subscribers' },
  { key: 'volume_m3', label: 'Volume (m³)' },
  { key: 'not_priced_volume_m3', label: 'Not priced (m³)' },
  { key: 'avg_use_m3', label: 'Avg use (m³/subscriber)' },
  { key: 'water_try', label: 'Water (₺)' },
  { key: 'wastewater_try', label: 'Wastewater (₺)' },
  { key: 'total_try', label: 'Total (₺)' },
  { key: 'average_price_per_m3', label: 'Average price (₺/m³)' },
];

function bandLabel(band) {
  return band.max == null ? `${fmtInt(band.min)}+ m³` : `${fmtInt(band.min)}–${fmtInt(band.max)} m³`;
}

function RevenueChartTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const point = payload[0].payload;
  return (
    <div className="chart-tooltip" role="group" aria-label={`${formatMonthLong(point.month)} details`}>
      <p className="chart-tooltip-label">{formatMonthLong(point.month)}</p>
      <p>Expected: {fmtTRY(point.total)}</p>
      <p>
        Range: {fmtTRY(point.range[0])} – {fmtTRY(point.range[1])}
      </p>
    </div>
  );
}

function RevenueEstimate() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const hasRevenueView = useMemo(() => Boolean(session?.permissions?.includes('revenue:view')), [session]);

  const [status, setStatus] = useState('loading'); // loading | ready | empty | error | forbidden
  const [errorReference, setErrorReference] = useState(null);
  const [data, setData] = useState(null);

  const [monthIndex, setMonthIndex] = useState(0);
  const [sortKey, setSortKey] = useState('total_try');
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
    if (sessionLoading || !session || !hasRevenueView) return;
    fetchData();
  }, [sessionLoading, session, hasRevenueView, fetchData]);

  const months = data?.months || [];
  const month = months[monthIndex] || null;

  // Same "Month Year1–Year3" style as Module 4's (DemandByDistrict.js)
  // share-years provenance text, e.g. "September 2021–2023" rather than
  // every year joined by a dash.
  const shareYearsLabel = useMemo(() => {
    if (!month?.share_years || month.share_years.length === 0) return '—';
    const sorted = [...month.share_years].sort((a, b) => a - b);
    const range = sorted.length === 1 ? `${sorted[0]}` : `${sorted[0]}–${sorted[sorted.length - 1]}`;
    return `${monthName(Number(month.month.slice(5, 7)))} ${range}`;
  }, [month]);

  const sortedGroups = useMemo(() => {
    const rows = month?.by_group || [];
    const copy = [...rows];
    copy.sort((a, b) => {
      let x = a[sortKey];
      let y = b[sortKey];
      if (sortKey === 'customer_group') {
        return sortDir === 'asc' ? x.localeCompare(y) : y.localeCompare(x);
      }
      if (x == null) x = -Infinity;
      if (y == null) y = -Infinity;
      return sortDir === 'asc' ? x - y : y - x;
    });
    return copy;
  }, [month, sortKey, sortDir]);

  const groupTotals = useMemo(() => {
    const rows = month?.by_group || [];
    if (rows.length === 0) return null;
    const subscribers = rows.reduce((sum, r) => sum + (r.subscribers || 0), 0);
    const volume_m3 = rows.reduce((sum, r) => sum + r.volume_m3, 0);
    const not_priced_volume_m3 = rows.reduce((sum, r) => sum + (r.not_priced_volume_m3 || 0), 0);
    const water_try = rows.reduce((sum, r) => sum + r.water_try, 0);
    const wastewater_try = rows.reduce((sum, r) => sum + r.wastewater_try, 0);
    const total_try = rows.reduce((sum, r) => sum + r.total_try, 0);
    // Same rule as each row: average price divides by priced volume only,
    // never by total volume — otherwise the totals row would understate
    // the real average price whenever any volume went unpriced.
    const pricedVolume = volume_m3 - not_priced_volume_m3;
    return {
      subscribers,
      volume_m3,
      not_priced_volume_m3,
      avg_use_m3: subscribers > 0 ? volume_m3 / subscribers : null,
      water_try,
      wastewater_try,
      total_try,
      average_price_per_m3: pricedVolume > 0 ? total_try / pricedVolume : null,
    };
  }, [month]);

  const chartRows = useMemo(
    () =>
      (data?.months || []).map((m) => ({
        month: m.month,
        total: m.totals.total.mid,
        range: [m.totals.total.low, m.totals.total.high],
      })),
    [data]
  );

  const viewportWidth = useViewportWidth();
  const narrowChart = viewportWidth < 600;

  const topGroup = month?.by_group && month.by_group.length > 0 ? month.by_group[0] : null;
  const summarySentence = useMemo(() => {
    if (!month || !topGroup) return null;
    const pct = month.totals.total.mid > 0 ? ((topGroup.total_try / month.totals.total.mid) * 100).toFixed(0) : '0';
    return (
      <>
        In <b>{formatMonthLong(month.month)}</b>, water and wastewater sales are expected to bring in about{' '}
        <b>{fmtTRY(month.totals.total.mid)}</b> ({fmtTRY(month.totals.total.low)} – {fmtTRY(month.totals.total.high)}),
        with <b>{groupLabel(topGroup.customer_group)}</b> the largest contributor at {pct}% of the total.
      </>
    );
  }, [month, topGroup]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'customer_group' ? 'asc' : 'desc');
    }
  };

  const handleExportCsv = () => {
    if (!month) return;
    const head = ['District', 'Customer group', 'Subscribers', 'Volume (m3)', 'Avg use (m3)', 'Water (TRY)', 'Wastewater (TRY)', 'Total (TRY)'];
    const lines = [head.join(',')].concat(
      (month.detail || []).map((r) =>
        [
          `"${r.district}"`,
          `"${r.customer_group}"`,
          r.subscribers ?? '',
          Math.round(r.volume_m3),
          r.avg_use_m3 == null ? '' : r.avg_use_m3.toFixed(1),
          r.water_try,
          r.wastewater_try,
          r.total_try,
        ].join(',')
      )
    );
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `revenue-estimate-${month.month}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (sessionLoading || !session) {
    return null;
  }

  const subtitle = 'How much money will water sales bring in?';

  return (
    <AppLayout title="Revenue estimate" subtitle={subtitle} requiredPermission="revenue:view">
      {status === 'loading' && (
        <>
          <div className="state-banner" role="status" aria-live="polite">
            <span className="state-banner-spinner" aria-hidden="true" />
            <div>Loading revenue estimate…</div>
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
          <h2>The revenue estimate couldn't be loaded.</h2>
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
          <h2>You don't have permission to view the revenue estimate.</h2>
        </section>
      )}

      {status === 'empty' && (
        <section className="card error-card" role="status">
          <span className="empty-icon" aria-hidden="true">
            <EmptyForecastIcon />
          </span>
          <h2>No forecast published</h2>
          <p>
            Revenue is estimated from the published city forecast, and none has been published yet. Ask your
            administrator to publish one.
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
              Estimates at July 2024 prices (the latest published tariff), excluding taxes. They are a lower bound:
              pricing the average customer under rising price steps undercounts what heavier users pay. They are
              also billed charges, not cash actually collected — some bills go unpaid.
            </span>
            <InfoTip id="tipMethod" label="How is revenue estimated?">
              <b>How is revenue estimated?</b>
              <br />
              Each district/subscriber-type cell's share of the city forecast is priced through the tariff's bands,
              assuming one average subscriber uses the same amount every month (as on a monthly bill).
              <br />
              Subscriber counts are assumed to still match {formatDateLong(data.subscribers_month)}, the latest month
              with data. İzmir raised prices in 2025, so actual income will be higher than this estimate.
              <br />
              The low–high range reflects city forecast uncertainty only — not tariff or subscriber-count
              uncertainty.
            </InfoTip>
          </p>

          <section className="kpis" aria-label="Key figures">
            <article className="card kpi accent">
              <div className="kpi-label">Expected revenue</div>
              <div className="kpi-value">{fmtTRYMillions(month.totals.total.mid)}</div>
              <div className="kpi-help">
                {fmtTRY(month.totals.total.low)} – {fmtTRY(month.totals.total.high)}
              </div>
            </article>
            <article className="card kpi">
              <div className="kpi-label">Water charge</div>
              <div className="kpi-value">{fmtTRYMillions(month.totals.water.mid)}</div>
              <div className="kpi-help">
                {fmtTRY(month.totals.water.low)} – {fmtTRY(month.totals.water.high)}
              </div>
            </article>
            <article className="card kpi">
              <div className="kpi-label">Wastewater charge</div>
              <div className="kpi-value">{fmtTRYMillions(month.totals.wastewater.mid)}</div>
              <div className="kpi-help">
                {fmtTRY(month.totals.wastewater.low)} – {fmtTRY(month.totals.wastewater.high)}
              </div>
            </article>
            <article className="card kpi">
              <div className="kpi-label">
                Not priced
                <InfoTip id="tipNotPriced" label="Why is some volume not priced?" align="right">
                  <b>Why is some volume not priced?</b>
                  {month.totals.not_priced_breakdown && month.totals.not_priced_breakdown.length > 0 ? (
                    month.totals.not_priced_breakdown.map((b) => (
                      <div key={b.reason}>
                        <br />
                        {fmtInt(b.volume_m3)} m³ ({b.count} cell{b.count === 1 ? '' : 's'}):{' '}
                        {NOT_PRICED_REASON_LABELS[b.reason] || b.reason}
                      </div>
                    ))
                  ) : (
                    <>
                      <br />
                      Every cell this month could be priced.
                    </>
                  )}
                </InfoTip>
              </div>
              <div className="kpi-value">{month.totals.not_priced_pct.toFixed(1)}%</div>
              <div className="kpi-help">{fmtInt(month.totals.not_priced_volume_m3)} m³ of billed volume</div>
            </article>
          </section>

          <section className="summary" aria-label="Summary" aria-live="polite">
            <span className="summary-icon" aria-hidden="true">
              <DropOutlineIcon />
            </span>
            <p>{summarySentence}</p>
          </section>

          <section className="card" aria-labelledby="chartTitle">
            <div className="card-head">
              <div>
                <h2 className="card-title" id="chartTitle">
                  Expected revenue by month
                </h2>
                <p className="card-sub">All published forecast months · Turkish lira</p>
              </div>
            </div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartRows} margin={{ top: 20, right: 20, bottom: 10, left: 10 }}>
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
                    label={{
                      value: 'Expected revenue (₺)',
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 11, textAnchor: 'middle', fill: '#475569' },
                    }}
                  />
                  <Tooltip content={<RevenueChartTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="range"
                    stroke="#0d7f80"
                    strokeOpacity={0.3}
                    strokeWidth={1}
                    fill="#0d7f80"
                    fillOpacity={0.15}
                    name="Low–high range"
                  />
                  <Bar dataKey="total" name="Expected revenue" radius={[3, 3, 0, 0]}>
                    {chartRows.map((row, i) => (
                      <Cell key={row.month} fill={i === monthIndex ? '#0b5c8f' : '#7fa9c7'} />
                    ))}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div className="legend" aria-hidden="true">
              <span>
                <i style={{ width: 14, height: 11, background: '#0b5c8f', borderRadius: 2, display: 'inline-block' }} />
                Selected month
              </span>
              <span>
                <i style={{ width: 14, height: 11, background: '#7fa9c7', borderRadius: 2, display: 'inline-block' }} />
                Other months
              </span>
              <span>
                <i className="lg-band" />
                Low–high range
              </span>
            </div>
          </section>

          <section className="card" aria-labelledby="groupTitle">
            <div className="card-head" style={{ paddingBottom: 6 }}>
              <div>
                <h2 className="card-title" id="groupTitle">
                  Revenue by customer group
                </h2>
                <p className="card-sub">{formatMonthLong(month.month)} · district detail exported to CSV below</p>
              </div>
              <button className="btn" type="button" onClick={handleExportCsv}>
                <DownloadIcon />
                Export district detail CSV
              </button>
            </div>
            <div className="table-wrap">
              <table className="district-table">
                <caption className="sr-only">
                  Revenue by customer group for the selected month. Column headers are buttons that sort the table.
                </caption>
                <thead>
                  <tr>
                    {GROUP_COLUMNS.map((c) => {
                      const active = sortKey === c.key;
                      const ariaSort = active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
                      const icon = ariaSort === 'ascending' ? '▲' : ariaSort === 'descending' ? '▼' : '↕';
                      return (
                        <th key={c.key} scope="col" aria-sort={ariaSort}>
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
                  {sortedGroups.map((g) => (
                    <tr key={g.customer_group}>
                      <th scope="row" style={{ textAlign: 'left', fontWeight: 600 }}>
                        {groupLabel(g.customer_group)}
                      </th>
                      <td>{fmtInt(g.subscribers)}</td>
                      <td>{fmtInt(g.volume_m3)}</td>
                      <td>{fmtInt(g.not_priced_volume_m3 || 0)}</td>
                      <td>{g.avg_use_m3 != null ? g.avg_use_m3.toFixed(1) : '—'}</td>
                      <td>{fmtTRY(g.water_try)}</td>
                      <td>{fmtTRY(g.wastewater_try)}</td>
                      <td>
                        <b>{fmtTRY(g.total_try)}</b>
                      </td>
                      <td>{g.average_price_per_m3 != null ? fmtTRYPerM3(g.average_price_per_m3) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                {groupTotals && (
                  <tfoot>
                    <tr>
                      <th scope="row" style={{ textAlign: 'left' }}>
                        All groups
                      </th>
                      <td>{fmtInt(groupTotals.subscribers)}</td>
                      <td>{fmtInt(groupTotals.volume_m3)}</td>
                      <td>{fmtInt(groupTotals.not_priced_volume_m3 || 0)}</td>
                      <td>{groupTotals.avg_use_m3 != null ? groupTotals.avg_use_m3.toFixed(1) : '—'}</td>
                      <td>{fmtTRY(groupTotals.water_try)}</td>
                      <td>{fmtTRY(groupTotals.wastewater_try)}</td>
                      <td>{fmtTRY(groupTotals.total_try)}</td>
                      <td>{groupTotals.average_price_per_m3 != null ? fmtTRYPerM3(groupTotals.average_price_per_m3) : '—'}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
            <div className="table-note">
              Average use and average price divide the group's volume/revenue by its subscriber count, not an
              average of individual subscribers. Price steps are assumed to apply per subscriber per month, as on
              monthly bills. Average price excludes not-priced volume — it divides revenue by the volume that was
              actually priced, not the group's total volume.
            </div>
          </section>

          <section className="card" aria-labelledby="tariffTitle">
            <div className="card-head" style={{ paddingBottom: 6 }}>
              <div>
                <h2 className="card-title" id="tariffTitle">
                  Tariff in use (valid from {data.tariff_version_date ? formatDateLong(data.tariff_version_date) : '—'})
                </h2>
                <p className="card-sub">Read-only — housing and workplace bands, water and wastewater, ₺ per m³</p>
              </div>
            </div>
            {Object.keys(data.tariffs_in_use || {}).length === 0 ? (
              <p style={{ padding: '0 20px 16px' }}>Tariff band details aren't available this month.</p>
            ) : (
              <div className="table-wrap">
                <table className="district-table">
                  <caption className="sr-only">Read-only tariff bands currently in use for housing and workplace subscribers.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Subscriber type</th>
                      <th scope="col">Band</th>
                      <th scope="col">Water (₺/m³)</th>
                      <th scope="col">Wastewater (₺/m³)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.tariffs_in_use).flatMap(([type, bands]) =>
                      bands.map((band, i) => (
                        <tr key={`${type}-${band.min}`}>
                          {i === 0 ? (
                            <th scope="row" rowSpan={bands.length} style={{ textAlign: 'left', fontWeight: 600, verticalAlign: 'top' }}>
                              {TARIFF_TYPE_LABELS[type] || type}
                            </th>
                          ) : null}
                          <td className="l">{bandLabel(band)}</td>
                          <td>{band.waterPrice != null ? fmtTRYPerM3(band.waterPrice) : '—'}</td>
                          <td>{band.wastewaterPrice != null ? fmtTRYPerM3(band.wastewaterPrice) : '—'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <footer className="foot">
            <p className="prov">
              Shares from district/subscriber-type consumption, <b>{shareYearsLabel}</b>
              {' · '}Forecast published <b>{formatPublishedDate(data.published_at)}</b>
              {' · '}Subscribers as of <b>{formatDateLong(data.subscribers_month)}</b>
              {' · '}Tariff dated <b>{data.tariff_version_date ? formatDateLong(data.tariff_version_date) : '—'}</b>
            </p>
          </footer>
        </>
      )}
    </AppLayout>
  );
}

export default RevenueEstimate;
