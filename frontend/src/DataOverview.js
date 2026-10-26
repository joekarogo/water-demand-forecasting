import { useEffect, useMemo, useState } from 'react';
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
import { apiFetch } from './apiClient';
import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import './App.css';

function DataOverview() {
  const navigate = useNavigate();
  const { session, loading: sessionLoading, clearSession } = useSession();
  const hasDataView = useMemo(() => Boolean(session?.permissions?.includes('data:view')), [session]);

  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (sessionLoading || !session) return;
    if (!hasDataView) {
      navigate('/dashboard', { replace: true });
    }
  }, [sessionLoading, session, hasDataView, navigate]);

  useEffect(() => {
    if (sessionLoading || !session || !hasDataView) {
      return;
    }

    const fetchHistory = async () => {
      setLoading(true);
      setError('');

      try {
        const response = await apiFetch('/api/consumption-history');

        if (response.status === 401) {
          clearSession();
          navigate('/login', {
            replace: true,
            state: { message: 'Your session has expired. Please sign in again.' },
          });
          return;
        }

        if (response.status === 403) {
          navigate('/dashboard', { replace: true });
          return;
        }

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
  }, [sessionLoading, session, hasDataView, navigate, clearSession]);

  if (sessionLoading || !session || !hasDataView) {
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
    <AppLayout title="Historical Analysis" subtitle="Monthly billed water consumption, İzmir">
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
    </AppLayout>
  );
}

export default DataOverview;
