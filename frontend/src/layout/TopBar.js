import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../apiClient';
import { useSession } from '../session';
import { getInitials } from '../utils/format';
import { LogoutIcon } from './icons';

function TopBar({ title, subtitle, extraLines, onMenuClick, menuBtnRef, navOpen }) {
  const navigate = useNavigate();
  const { session, clearSession } = useSession();
  const name = session?.name || '';
  const roleLabel = session?.role_label || '';

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // ignore — we're signing out locally regardless
    }
    localStorage.removeItem('token');
    clearSession();
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
