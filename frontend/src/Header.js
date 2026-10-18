import { useNavigate } from 'react-router-dom';
import { getUserRole } from './utils/decodeToken';
import './App.css';

function Header({ title }) {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');
  const role = getUserRole(token);

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login', { replace: true });
  };

  const roleLabel = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';

  return (
    <div className="page-header">
      <h2>{title}</h2>
      <div className="page-header-right">
        {roleLabel && <span className="role-badge">{roleLabel}</span>}
        <button className="header-logout" onClick={handleLogout}>
          Logout
        </button>
      </div>
    </div>
  );
}

export default Header;
