import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../apiClient';
import { useSession } from '../session';
import { getInitials } from '../utils/format';
import { LogoutIcon } from './icons';

// The user menu's own items — besides Sign out, every one of these is a
// plain in-app page with no extra permission required (see App.js).
const USER_MENU_LINKS = [
  { label: 'My account', path: '/account' },
  { label: 'Help', path: '/help' },
  { label: 'Privacy', path: '/privacy' },
  { label: 'About', path: '/about' },
];

function TopBar({ title, subtitle, extraLines, onMenuClick, menuBtnRef, navOpen }) {
  const navigate = useNavigate();
  const { session, clearSession } = useSession();
  const name = session?.name || '';
  // The job title (if the admin has set one) takes priority over the
  // role label — both come from GET /api/me, never hard-coded here.
  const subtitleLabel = session?.job_title || session?.role_label || '';
  const subtitleTitle = session?.job_title ? 'Job title' : 'Signed-in role';

  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  const closeMenu = () => setMenuOpen(false);

  // Disclosure pattern: a click outside, or Escape, closes the menu —
  // Escape also returns focus to the button that opened it.
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (e) => {
      if (menuRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return;
      closeMenu();
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        closeMenu();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const handleLogout = async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // ignore — we're signing out locally regardless
    }
    clearSession();
    navigate('/login', { replace: true, state: { message: "You've signed out." } });
  };

  const goTo = (path) => {
    closeMenu();
    navigate(path);
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
        <div className="user-menu-wrap">
          <button
            type="button"
            className="user-menu-btn"
            aria-expanded={menuOpen}
            aria-controls="userMenu"
            onClick={() => setMenuOpen((open) => !open)}
            ref={triggerRef}
          >
            <span className="avatar" aria-hidden="true">
              {getInitials(name)}
            </span>
            <span className="user-name">{name}</span>
            {subtitleLabel && (
              <span className="role" title={subtitleTitle}>
                {subtitleLabel}
              </span>
            )}
          </button>
          {menuOpen && (
            <div className="user-menu" id="userMenu" aria-label="Account menu" ref={menuRef}>
              <div className="user-menu-head">
                <div className="user-menu-name">{name}</div>
                <div className="user-menu-email">{session?.email}</div>
                {subtitleLabel && <div className="user-menu-role">{subtitleLabel}</div>}
              </div>
              <ul className="user-menu-list">
                {USER_MENU_LINKS.map((item) => (
                  <li key={item.path}>
                    <button type="button" onClick={() => goTo(item.path)}>
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="user-menu-signout" onClick={handleLogout}>
                <LogoutIcon />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default TopBar;
