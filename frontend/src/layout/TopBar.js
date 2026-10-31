import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../apiClient';
import { useSession } from '../session';
import { getInitials } from '../utils/format';
import { LogoutIcon } from './icons';

function TopBar({ title, subtitle, extraLines, onMenuClick, menuBtnRef, navOpen }) {
  const navigate = useNavigate();
  const { session, clearSession } = useSession();
  const name = session?.name || '';
  // The job title (if the admin has set one) takes priority over the
  // role label — both come from GET /api/me, never hard-coded here.
  const subtitleLabel = session?.job_title || session?.role_label || '';
  const subtitleTitle = session?.job_title ? 'Job title' : 'Signed-in role';

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // ignore — we're signing out locally regardless
    }
    clearSession();
    navigate('/login', { replace: true, state: { message: "You've signed out." } });
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
        {subtitleLabel && (
          <span className="role" title={subtitleTitle}>
            {subtitleLabel}
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
