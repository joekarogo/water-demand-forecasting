import { NavLink } from 'react-router-dom';
import { getUserRole } from './utils/decodeToken';
import './App.css';

function Sidebar() {
  const token = localStorage.getItem('token');
  const role = getUserRole(token);

  return (
    <nav className="sidebar">
      <h3 className="sidebar-title">Water Demand</h3>
      <NavLink
        to="/dashboard"
        className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
      >
        Forecast
      </NavLink>
      {role === 'admin' && (
        <NavLink
          to="/data-overview"
          className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
        >
          Historical Analysis
        </NavLink>
      )}
    </nav>
  );
}

export default Sidebar;
