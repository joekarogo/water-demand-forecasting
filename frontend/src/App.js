import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SessionProvider } from './session';
import Login from './Login';
import EmergencyLogin from './EmergencyLogin';
import Dashboard from './Dashboard';
import DataOverview from './DataOverview';
import ProductionPlanning from './ProductionPlanning';
import './App.css';

function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<Login />} />
          <Route path="/emergency-login" element={<EmergencyLogin />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/data-overview" element={<DataOverview />} />
          <Route path="/production-planning" element={<ProductionPlanning />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}

export default App;
