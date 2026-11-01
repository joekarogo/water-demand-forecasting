import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SessionProvider } from './session';
import Login from './Login';
import EmergencyLogin from './EmergencyLogin';
import Overview from './Overview';
import Dashboard from './Dashboard';
import DataOverview from './DataOverview';
import ProductionPlanning from './ProductionPlanning';
import DemandByDistrict from './DemandByDistrict';
import RevenueEstimate from './RevenueEstimate';
import Users from './Users';
import MyAccount from './MyAccount';
import Help from './Help';
import Privacy from './Privacy';
import About from './About';
import NotFound from './NotFound';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/emergency-login" element={<EmergencyLogin />} />
          <Route path="/overview" element={<Overview />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/data-overview" element={<DataOverview />} />
          <Route path="/production-planning" element={<ProductionPlanning />} />
          <Route path="/demand-by-district" element={<DemandByDistrict />} />
          <Route path="/revenue" element={<RevenueEstimate />} />
          <Route path="/users" element={<Users />} />
          <Route path="/account" element={<MyAccount />} />
          <Route path="/help" element={<Help />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}

export default App;
