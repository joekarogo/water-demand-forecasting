import { useNavigate } from 'react-router-dom';
import { decodeToken } from '../utils/decodeToken';
import { getInitials } from '../utils/format';
import { ROLE_LABELS } from './menuConfig';
import { LogoutIcon } from './icons';

function TopBar({ title, subtitle, extraLines, onMenuClick, menuBtnRef, navOpen }) {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');
  const decoded = decodeToken(token);
  const name = decoded?.name || '';
  const role = decoded?.role;
  const roleLabel = ROLE_LABELS[role] || role || '';

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login', { replace: true });
  };

  return (
    <header className="topbar">
      <button
        className="menu-btn"
        type="button"
        aria-label="Open navigation"
        aria-controls="sidebar"
        aria-expanded={navOpen}
        onClick={onMenuClick}
        ref={menuBtnRef}
      >
        <span aria-hidden="true">☰</span>
      </button>
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="sub">{subtitle}</p>}
        {extraLines}
      </div>
      <div className="user">
        <span className="avatar" aria-hidden="true">
          {getInitials(name)}
        </span>
        <span className="user-name">{name}</span>
        {roleLabel && (
          <span className="role" title="Signed-in role">
            {roleLabel}
          </span>
        )}
        <button className="btn" type="button" aria-label="Log out" onClick={handleLogout}>
          <LogoutIcon />
          <span className="logout-label">Logout</span>
        </button>
      </div>
    </header>
  );
}

export default TopBar;
