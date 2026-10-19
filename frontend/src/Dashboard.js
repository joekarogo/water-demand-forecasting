import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import Sidebar from './Sidebar';
import Header from './Header';
import './App.css';

const HORIZON_OPTIONS = [3, 6, 12];
const HISTORY_MONTHS_SHOWN = 36;

const formatMonthShort = (dateStr) =>
  new Date(dateStr).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

const formatMonthLong = (dateStr) =>
  new Date(dateStr).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

const fmtNumber = (value) => Math.round(value).toLocaleString();

// Custom tooltip in plain language, instead of exposing the stacked-area
// "lower"/"range" implementation details used to draw the confidence band.
function ForecastTooltip({ active, payload, label }) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const point = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-label">{formatMonthLong(label)}</p>
      {point.actual !== undefined && <p>Actual consumption: {fmtNumber(point.actual)} m³</p>}
      {point.yhat !== undefined && <p>Forecast: {fmtNumber(point.yhat)} m³</p>}
      {point.lower !== undefined && point.range !== undefined && (
        <p>
          {point.intervalLabel}: {fmtNumber(point.lower)} – {fmtNumber(point.lower + point.range)} m³
        </p>
      )}
    </div>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');

  const [horizon, setHorizon] = useState(6);
  const [forecastData, setForecastData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recentForecasts, setRecentForecasts] = useState([]);

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true });
    }
  }, [token, navigate]);

  const fetchRecentForecasts = useCallback(async () => {
    try {
      const response = await fetch('http://localhost:5000/api/forecasts/recent', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (response.ok) {
        setRecentForecasts(data.data);
      }
    } catch (err) {
      // Recent forecasts are a nice-to-have — a failure here shouldn't
      // disrupt the rest of the page.
    }
  }, [token]);

  useEffect(() => {
    if (token) {
      fetchRecentForecasts();
    }
  }, [token, fetchRecentForecasts]);

  const handleGenerateForecast = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`http://localhost:5000/api/forecast?horizon=${horizon}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to load forecast data. Please try again.');
        return;
      }

      setForecastData(data);
      fetchRecentForecasts();
    } catch (err) {
      setError('Unable to reach the server. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return null;
  }

  // Prophet's default is 0.8 (80%) — read from the model via the API rather
  // than hardcoded, so this stays correct if that default is ever changed.
  const intervalPercent = forecastData ? Math.round(forecastData.interval_width * 100) : null;
  const intervalLabel = intervalPercent !== null ? `${intervalPercent}% uncertainty range` : 'Uncertainty range';

  // Combine recent history with the forecast into one chart dataset, keyed
  // by date so the connector point (the model's fitted value at the last
  // actual month) merges into the SAME row as that month's actual value —
  // this is what makes the forecast line start with no gap after history.
  const chartData = (() => {
    if (!forecastData) {
      return [];
    }
    const map = new Map();

    forecastData.history.slice(-HISTORY_MONTHS_SHOWN).forEach((row) => {
      map.set(row.date, { date: row.date, actual: row.actual });
    });

    const addForecastPoint = (row) => {
      const existing = map.get(row.date) || { date: row.date };
      map.set(row.date, {
        ...existing,
        yhat: row.yhat,
        lower: row.yhat_lower,
        range: row.yhat_upper - row.yhat_lower,
        intervalLabel,
      });
    };

    addForecastPoint({
      date: forecastData.connector.date,
      yhat: forecastData.connector.yhat,
      yhat_lower: forecastData.connector.yhat_lower,
      yhat_upper: forecastData.connector.yhat_upper,
    });
    forecastData.forecast.forEach(addForecastPoint);

    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  })();

  // Y axis domain: start ~10% below the lowest value shown (including the
  // lower uncertainty bound), rounded down to a whole million, and end ~5%
  // above the highest value (including the upper bound), rounded up to a
  // whole million — instead of the default 0-based domain, so the seasonal
  // pattern is actually visible. `allowDataOverflow` is required here:
  // Recharts otherwise silently extends a stacked Area's axis down to 0
  // regardless of an explicit domain.
  const allChartValues = chartData.flatMap((d) => {
    const values = [];
    if (d.actual !== undefined) values.push(d.actual);
    if (d.yhat !== undefined) values.push(d.yhat);
    if (d.lower !== undefined && d.range !== undefined) {
      values.push(d.lower, d.lower + d.range);
    }
    return values;
  });
  const minChartValue = allChartValues.length > 0 ? Math.min(...allChartValues) : 0;
  const maxChartValue = allChartValues.length > 0 ? Math.max(...allChartValues) : 0;
  const yDomainMin = minChartValue > 0 ? Math.floor((minChartValue * 0.9) / 1000000) * 1000000 : 0;
  const yDomainMax = maxChartValue > 0 ? Math.ceil((maxChartValue * 1.05) / 1000000) * 1000000 : undefined;

  // ~8 visible X axis labels regardless of how many months are plotted,
  // so month labels never overlap.
  const xTickInterval = Math.max(1, Math.floor(chartData.length / 8));

  const prophetMetrics = forecastData?.metrics;
  const seasonalNaive = forecastData?.baselines?.seasonal_naive;
  const lastYearGrowth = forecastData?.baselines?.last_year_growth;

  const accuracyVsGrowth =
    prophetMetrics && lastYearGrowth
      ? ((lastYearGrowth.mape - prophetMetrics.mape) / lastYearGrowth.mape) * 100
      : null;

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="dashboard-container">
        <Header title="Forecast" />

        <div className="forecast-controls">
          <label htmlFor="horizon-select">Forecast horizon:</label>
          <select
            id="horizon-select"
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
            disabled={loading}
          >
            {HORIZON_OPTIONS.map((h) => (
              <option key={h} value={h}>
                {h} months
              </option>
            ))}
          </select>
          <button className="btn-primary" onClick={handleGenerateForecast} disabled={loading}>
            {loading ? 'Generating...' : 'Generate Forecast'}
          </button>
        </div>

        {loading && (
          <div className="spinner-container">
            <div className="spinner" />
            <p>Running forecast model, this may take a moment...</p>
          </div>
        )}

        {error && <p className="dashboard-error">{error}</p>}

        {forecastData && !loading && (
          <>
            <h3 className="chart-title">Consumption History &amp; {forecastData.horizon}-Month Forecast</h3>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={chartData} margin={{ top: 30, right: 20, bottom: 10, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={formatMonthShort}
                    tick={{ fontSize: 12 }}
                    interval={xTickInterval}
                    minTickGap={20}
                  />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value) => `${(value / 1000000).toFixed(0)}M`}
                    domain={[yDomainMin, yDomainMax]}
                    allowDataOverflow
                    label={{
                      value: 'Consumption (m³)',
                      angle: -90,
                      position: 'insideLeft',
                      style: { fontSize: 12, textAnchor: 'middle' },
                    }}
                  />
                  <Tooltip content={<ForecastTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 13 }} />
                  <ReferenceLine
                    x={forecastData.connector.date}
                    stroke="#999"
                    strokeDasharray="3 3"
                    label={{ value: 'Forecast starts', position: 'insideTopRight', fontSize: 12, fill: '#555' }}
                  />
                  <Line
                    dataKey="actual"
                    stroke="#61dafb"
                    strokeWidth={2}
                    dot={false}
                    name="Actual consumption"
                    connectNulls
                  />
                  <Area
                    dataKey="lower"
                    stackId="ci"
                    stroke="none"
                    fill="transparent"
                    legendType="none"
                    name="lower"
                  />
                  <Area
                    dataKey="range"
                    stackId="ci"
                    stroke="none"
                    fill="#8884d8"
                    fillOpacity={0.25}
                    name={intervalLabel}
                  />
                  <Line
                    dataKey="yhat"
                    stroke="#282c34"
                    strokeWidth={2}
                    dot
                    name="Forecast"
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="model-info">
              <h3>Model Performance</h3>
              <table className="model-info-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>MAE (m3)</th>
                    <th>MAPE</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Prophet</td>
                    <td>{prophetMetrics.mae.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td>{prophetMetrics.mape.toFixed(2)}%</td>
                  </tr>
                  <tr>
                    <td>Seasonal-Naive</td>
                    <td>{seasonalNaive.mae.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td>{seasonalNaive.mape.toFixed(2)}%</td>
                  </tr>
                  <tr>
                    <td>Last-Year x Growth</td>
                    <td>{lastYearGrowth.mae.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td>{lastYearGrowth.mape.toFixed(2)}%</td>
                  </tr>
                </tbody>
              </table>
              {accuracyVsGrowth !== null && (
                <p className="model-performance-note">
                  Prophet is {Math.abs(accuracyVsGrowth).toFixed(1)}%{' '}
                  {accuracyVsGrowth >= 0 ? 'more' : 'less'} accurate than using last year's figures.
                </p>
              )}
            </div>

            <h3>Forecast Detail</h3>
            <table className="forecast-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Predicted Demand (m3)</th>
                  <th>Lower Bound (m3)</th>
                  <th>Upper Bound (m3)</th>
                </tr>
              </thead>
              <tbody>
                {forecastData.forecast.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{row.yhat.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td>{row.yhat_lower.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td>{row.yhat_upper.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {recentForecasts.length > 0 && (
          <div className="model-info">
            <h3>Recent Forecasts</h3>
            <table className="model-info-table">
              <thead>
                <tr>
                  <th>Generated</th>
                  <th>Horizon</th>
                  <th>MAPE</th>
                </tr>
              </thead>
              <tbody>
                {recentForecasts.map((f) => (
                  <tr key={f.forecast_id}>
                    <td>{new Date(f.generated_at).toLocaleString()}</td>
                    <td>{f.horizon} months</td>
                    <td>{f.mape !== null ? `${Number(f.mape).toFixed(2)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

export default Dashboard;
