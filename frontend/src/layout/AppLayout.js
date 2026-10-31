import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../session';
import { getFirstPermittedPath } from './menuConfig';
import { useDocumentTitle } from '../useDocumentTitle';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import SessionExpiryWarning from '../SessionExpiryWarning';
import '../App.css';

// Shared shell: fixed sidebar + topbar on wide screens, a ☰-triggered overlay
// sidebar on narrow ones (closable with ✕, a tap outside, or Escape).
// Also the route guard for every page that uses it: signed-out users
// (session === null, once the initial GET /api/me has resolved) are sent
// to /login instead of ever seeing the shell or its children. A page that
// passes `requiredPermission` and whose signed-in user lacks it sees an
// "access denied" view inside the normal shell instead of its children —
// it never gets redirected away.
function AppLayout({ title, subtitle, extraLines, requiredPermission, children }) {
  const { session, loading } = useSession();
  const navigate = useNavigate();
  const [navOpen, setNavOpen] = useState(false);
  const menuBtnRef = useRef(null);
  const closeBtnRef = useRef(null);

  const closeNav = () => setNavOpen(false);

  useDocumentTitle(title);

  useEffect(() => {
    if (!loading && !session) {
      navigate('/login', { replace: true });
    }
  }, [loading, session, navigate]);

  useEffect(() => {
    if (navOpen) {
      closeBtnRef.current?.focus();
    }
  }, [navOpen]);

  useEffect(() => {
    if (!navOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setNavOpen(false);
        menuBtnRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [navOpen]);

  if (loading || !session) {
    return null;
  }

  const hasAccess = !requiredPermission || (session.permissions || []).includes(requiredPermission);

  return (
    <div className="shell">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <SessionExpiryWarning />
      <Sidebar open={navOpen} onNavigate={closeNav} onClose={closeNav} closeBtnRef={closeBtnRef} />
      {navOpen && <div className="scrim" onClick={closeNav} />}
      <div className="main">
        <TopBar
          title={title}
          subtitle={subtitle}
          extraLines={extraLines}
          onMenuClick={() => setNavOpen(true)}
          menuBtnRef={menuBtnRef}
          navOpen={navOpen}
        />
        <main className="content" id="main-content" tabIndex="-1">
          {hasAccess ? (
            children
          ) : (
            <section className="card error-card" role="alert">
              <h2>You don't have access to this page.</h2>
              <button
                className="btn btn-primary"
                type="button"
                style={{ marginTop: 8 }}
                onClick={() => navigate(getFirstPermittedPath(session.permissions))}
              >
                Go to a page you can access
              </button>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

export default AppLayout;
