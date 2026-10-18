import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import Sidebar from './Sidebar';
import Header from './Header';
import { getUserRole } from './utils/decodeToken';
import './App.css';

function DataOverview() {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');
  const role = getUserRole(token);

  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true });
      return;
    }
    if (role !== 'admin') {
      navigate('/dashboard', { replace: true });
    }
  }, [token, role, navigate]);

  useEffect(() => {
    if (!token || role !== 'admin') {
      return;
    }

    const fetchHistory = async () => {
      setLoading(true);
      setError('');

      try {
        const response = await fetch('http://localhost:5000/api/consumption-history', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        const data = await response.json();

        if (!response.ok) {
          setError(data.error || 'Failed to load consumption history');
          return;
        }

        setHistory(data.data);
      } catch (err) {
        setError('Unable to reach the server. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [token, role]);

  if (!token || role !== 'admin') {
    return null;
  }

  const formatMonth = (dateStr) =>
    new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });

  const totalRecords = history.length;
  const avgConsumption =
    totalRecords > 0
      ? history.reduce((sum, row) => sum + row.consumption_m3, 0) / totalRecords
      : 0;
  const peakRow =
    totalRecords > 0
      ? history.reduce((max, row) => (row.consumption_m3 > max.consumption_m3 ? row : max), history[0])
      : null;

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="dashboard-container">
        <Header title="Historical Analysis" />

        {loading && (
          <div className="spinner-container">
            <div className="spinner" />
            <p>Loading historical data...</p>
          </div>
        )}

        {error && <p className="dashboard-error">{error}</p>}

        {!loading && !error && history.length > 0 && (
          <>
            <div className="metric-cards">
              <div className="metric-card">
                <h3>Date Range</h3>
                <p>
                  {formatMonth(history[0].date)} – {formatMonth(history[totalRecords - 1].date)}
                </p>
              </div>
              <div className="metric-card">
                <h3>Total Records</h3>
                <p>{totalRecords}</p>
              </div>
              <div className="metric-card">
                <h3>Avg Monthly Consumption</h3>
                <p>{Math.round(avgConsumption).toLocaleString()} m3</p>
              </div>
              <div className="metric-card">
                <h3>Peak Month</h3>
                <p>
                  {formatMonth(peakRow.date)}
                  <br />
                  {peakRow.consumption_m3.toLocaleString()} m3
                </p>
              </div>
            </div>

            <div className="chart-container">
              <ResponsiveContainer width="100%" height={320}>
                <LineChart data={history}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={false} />
                  <YAxis tickFormatter={(value) => `${(value / 1000000).toFixed(0)}M`} />
                  <Tooltip formatter={(value) => value.toLocaleString()} />
                  <Line
                    dataKey="consumption_m3"
                    stroke="#282c34"
                    strokeWidth={2}
                    dot={false}
                    name="Consumption (m3)"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default DataOverview;
