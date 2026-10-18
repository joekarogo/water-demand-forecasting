import { useEffect, useState } from 'react';
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
  ResponsiveContainer,
} from 'recharts';
import Sidebar from './Sidebar';
import Header from './Header';
import './App.css';

function Dashboard() {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');

  const [forecastData, setForecastData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true });
    }
  }, [token, navigate]);

  const handleGenerateForecast = async () => {
    setLoading(true);
    setError('');

    try {
      const response = await fetch('http://localhost:5000/api/forecast', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || 'Failed to load forecast data');
        return;
      }

      setForecastData(data);
    } catch (err) {
      setError('Unable to reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return null;
  }

  const chartData = forecastData
    ? forecastData.forecast.map((row) => ({
        date: row.date,
        yhat: row.yhat,
        lower: row.yhat_lower,
        range: row.yhat_upper - row.yhat_lower,
      }))
    : [];

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="dashboard-container">
        <Header title="Forecast" />

        <button onClick={handleGenerateForecast} disabled={loading}>
          {loading ? 'Generating...' : 'Generate Forecast'}
        </button>

        {loading && (
          <div className="spinner-container">
            <div className="spinner" />
            <p>Running forecast model, this may take a moment...</p>
          </div>
        )}

        {error && <p className="dashboard-error">{error}</p>}

        {forecastData && !loading && (
          <>
            <div className="metric-cards">
              <div className="metric-card">
                <h3>MAE</h3>
                <p>{forecastData.mae.toLocaleString()} m3</p>
              </div>
              <div className="metric-card">
                <h3>RMSE</h3>
                <p>{forecastData.rmse.toLocaleString()} m3</p>
              </div>
              <div className="metric-card">
                <h3>MAPE</h3>
                <p>{forecastData.mape}%</p>
              </div>
            </div>

            <h3>6 Month Forecast</h3>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis tickFormatter={(value) => `${(value / 1000000).toFixed(0)}M`} />
                  <Tooltip formatter={(value) => value.toLocaleString()} />
                  <Legend />
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
                    name="Confidence Interval"
                  />
                  <Line
                    dataKey="yhat"
                    stroke="#282c34"
                    strokeWidth={2}
                    dot
                    name="Predicted (yhat)"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <table className="forecast-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Predicted Consumption (m3)</th>
                </tr>
              </thead>
              <tbody>
                {forecastData.forecast.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{row.yhat.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </main>
    </div>
  );
}

export default Dashboard;
