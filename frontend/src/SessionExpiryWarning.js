import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import { subscribeSessionExpiry, getSessionExpiry } from './sessionExpiry';
import './App.css';

const WARNING_WINDOW_MS = 2 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;
const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Please sign in again.';

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatClockTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Mounted once, inside AppLayout, so it's present on every authenticated
// page. Watches the shared expiry state from sessionExpiry.js (itself
// updated from the X-Session-Expires-In header on every apiFetch
// response, in any tab) and warns 2 minutes before it runs out.
function SessionExpiryWarning() {
  const navigate = useNavigate();
  const { clearSession, extendSession } = useSession();
  const [visible, setVisible] = useState(false);
  const [maxReached, setMaxReached] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const dialogRef = useRef(null);
  const primaryBtnRef = useRef(null);
  const openerRef = useRef(null);
  // The expiresAt the max-reached dialog was last dismissed for — while
  // it still matches the current one, the dialog stays closed instead of
  // popping back up every 15s check for the rest of this session.
  const dismissedMaxExpiresAtRef = useRef(null);

  // Real expiry (the countdown running out, or a "Stay signed in" click
  // that discovers the session is already gone) — always the expiry
  // message, distinct from a deliberate Sign out click below.
  const signOut = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // ignore — signing out locally regardless
    }
    clearSession();
    navigate('/login', { replace: true, state: { message: SESSION_EXPIRED_MESSAGE } });
  }, [clearSession, navigate]);

  // A deliberate Sign out click from the dialog — same flow as the
  // top-bar Sign out, with the normal sign-out message, not the expiry one.
  const handleSignOutClick = useCallback(async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // ignore — signing out locally regardless
    }
    clearSession();
    navigate('/login', { replace: true, state: { message: "You've signed out." } });
  }, [clearSession, navigate]);

  // Whether to show the warning, from the shared expiry state — checked
  // on a 15s timer, whenever the tab regains visibility (a backgrounded
  // tab's timers can fall behind), and immediately when another tab
  // changes the shared state (e.g. it extended the session for everyone).
  useEffect(() => {
    const check = () => {
      const { expiresAt, maxReached: reachedCap } = getSessionExpiry();
      if (!expiresAt) {
        setVisible(false);
        return;
      }
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        setVisible(false);
        signOut();
        return;
      }
      if (remaining <= WARNING_WINDOW_MS) {
        if (reachedCap && dismissedMaxExpiresAtRef.current === expiresAt) {
          setVisible(false);
          return;
        }
        setMaxReached(reachedCap);
        setRemainingMs(remaining);
        setVisible(true);
      } else {
        setVisible(false);
      }
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', check);
    const unsubscribe = subscribeSessionExpiry(check);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', check);
      unsubscribe();
    };
  }, [signOut]);

  // A live, per-second countdown while the dialog is actually open, and
  // the moment of real expiry even if the 15s check above hasn't run yet.
  useEffect(() => {
    if (!visible) return;
    const tick = setInterval(() => {
      const { expiresAt } = getSessionExpiry();
      if (!expiresAt) return;
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        clearInterval(tick);
        setVisible(false);
        signOut();
        return;
      }
      setRemainingMs(remaining);
    }, 1000);
    return () => clearInterval(tick);
  }, [visible, signOut]);

  useEffect(() => {
    if (visible) {
      openerRef.current = document.activeElement;
      primaryBtnRef.current?.focus();
    } else if (openerRef.current) {
      openerRef.current.focus?.();
      openerRef.current = null;
    }
  }, [visible]);

  // Keeps focus inside the dialog while it's open — this warning needs
  // an explicit choice, so (unlike the user menu) Escape doesn't dismiss it.
  useEffect(() => {
    if (!visible) return;
    const handleKeyDown = (e) => {
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll('button')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [visible]);

  const handleStaySignedIn = async () => {
    let response;
    try {
      // GET /api/me goes through authenticateToken same as any other
      // request, which is what actually performs the sliding-expiry
      // update server-side — no dedicated "extend" endpoint needed.
      response = await apiFetch('/api/me');
    } catch (err) {
      // network failure — leave it to the next 15s check / countdown
      setVisible(false);
      return;
    }
    if (response.status === 401) {
      // The session was already gone by the time this click landed —
      // sign out now, with the real expiry message, instead of just
      // closing the dialog as if nothing happened.
      setVisible(false);
      signOut();
      return;
    }
    if (response.ok) {
      const body = await response.json();
      extendSession(body);
    }
    setVisible(false);
  };

  const handleDismissMaxReached = () => {
    dismissedMaxExpiresAtRef.current = getSessionExpiry().expiresAt;
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="modal-scrim">
      <div
        className="modal-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sessionExpiryTitle"
        aria-describedby="sessionExpiryDesc"
        ref={dialogRef}
      >
        <h2 id="sessionExpiryTitle">{maxReached ? 'Session ending soon' : 'Your session is about to end'}</h2>
        <p id="sessionExpiryDesc">
          {maxReached ? (
            <>
              For security, sessions end after 8 hours. Save your work; you'll need to sign in again at{' '}
              {formatClockTime(Date.now() + remainingMs)}.
            </>
          ) : (
            <>Your session will end in {formatCountdown(remainingMs)} because you've been inactive.</>
          )}
        </p>
        <div className="modal-actions">
          {maxReached ? (
            <button type="button" className="btn btn-primary" ref={primaryBtnRef} onClick={handleDismissMaxReached}>
              OK
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={handleSignOutClick}>
                Sign out
              </button>
              <button type="button" className="btn btn-primary" ref={primaryBtnRef} onClick={handleStaySignedIn}>
                Stay signed in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SessionExpiryWarning;
