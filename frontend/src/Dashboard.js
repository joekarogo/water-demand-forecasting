import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './App.css';

function Dashboard() {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');

  const [forecastData, setForecastData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) {
      navigate('/login', { replace: true });
    }
  }, [token, navigate]);

  useEffect(() => {
    if (!token) {
      return;
    }

    const fetchForecast = async () => {
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

    fetchForecast();
  }, [token]);

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login', { replace: true });
  };

  if (!token) {
    return null;
  }

  return (
    <div className="dashboard-container">
      <h2>Welcome to the Water Demand Forecasting Dashboard</h2>
      <button onClick={handleLogout}>Logout</button>

      {loading && <p>Loading forecast data...</p>}
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
    </div>
  );
}

export default Dashboard;
