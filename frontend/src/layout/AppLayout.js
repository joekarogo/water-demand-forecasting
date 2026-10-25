import { useEffect, useRef, useState } from 'react';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import '../App.css';

// Shared shell: fixed sidebar + topbar on wide screens, a ☰-triggered overlay
// sidebar on narrow ones (closable with ✕, a tap outside, or Escape).
function AppLayout({ title, subtitle, extraLines, children }) {
  const [navOpen, setNavOpen] = useState(false);
  const menuBtnRef = useRef(null);
  const closeBtnRef = useRef(null);

  const closeNav = () => setNavOpen(false);

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

  return (
    <div className="shell">
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
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export default AppLayout;
