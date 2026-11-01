import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import { AlertCircleIcon, ClockIcon, CheckCircleIcon } from './layout/icons';
import AuthLayout from './AuthLayout';
import { useDocumentTitle } from './useDocumentTitle';
import './App.css';

const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;
const SIGNED_OUT_MESSAGE = "You've signed out.";

function Login() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refreshSession } = useSession();
  const googleButtonRef = useRef(null);

  const [googleError, setGoogleError] = useState('');
  const [navMessage, setNavMessage] = useState(location.state?.message || '');
  const [signingIn, setSigningIn] = useState(false);

  useDocumentTitle('Sign in');

  // Google Identity Services renders its own button into googleButtonRef
  // once the gsi/client script (loaded in public/index.html) is ready; we
  // poll for it rather than assume it has finished loading by the time we
  // mount. That button stays mounted the whole time — while a sign-in is
  // pending we only hide it with CSS and show the busy indicator next to
  // it, so there's nothing to re-render into it afterwards.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    const handleCredential = async (response) => {
      setGoogleError('');
      setNavMessage('');
      setSigningIn(true);
      try {
        const res = await apiFetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: response.credential }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setGoogleError(data.error || "This Google account isn't authorised for this system. Contact your administrator.");
          return;
        }
        await refreshSession();
        // Overview is the landing page for every role (it has no
        // permission gate of its own) — existing deep links to a
        // specific page are untouched, since this only applies right
        // after signing in.
        navigate('/overview', { replace: true });
      } catch (err) {
        setGoogleError("We couldn't reach the server. Check your connection and try again.");
      } finally {
        setSigningIn(false);
      }
    };

    const tryInit = () => {
      if (cancelled) return;
      if (window.google?.accounts?.id && googleButtonRef.current) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleCredential,
        });
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          theme: 'outline',
          size: 'large',
          width: 300,
        });
      } else {
        setTimeout(tryInit, 100);
      }
    };
    tryInit();

    return () => {
      cancelled = true;
    };
  }, [navigate, refreshSession]);

  return (
    <AuthLayout title="Sign in" subtitle="Use your registered Google account.">
      <div className="msg-slot" role="alert">
        {(googleError || !GOOGLE_CLIENT_ID) && (
          <div className="msg red">
            <AlertCircleIcon />
            <span>{googleError || "Google sign-in isn't configured (missing REACT_APP_GOOGLE_CLIENT_ID)."}</span>
          </div>
        )}
      </div>
      <div className="msg-slot" role="status">
        {navMessage && (
          <div className={`msg ${navMessage === SIGNED_OUT_MESSAGE ? 'green' : 'amber'}`}>
            {navMessage === SIGNED_OUT_MESSAGE ? <CheckCircleIcon /> : <ClockIcon />}
            <span>{navMessage}</span>
          </div>
        )}
        {signingIn && <span className="sr-only">Signing you in…</span>}
      </div>

      {GOOGLE_CLIENT_ID && (
        <div className="gsi-wrap">
          <div ref={googleButtonRef} style={signingIn ? { display: 'none' } : undefined} />
          {signingIn && (
            <div className="gsi-busy">
              <span className="spinner" aria-hidden="true" />
              <span>Signing you in…</span>
            </div>
          )}
        </div>
      )}

      <p className="help">No access? Contact your system administrator.</p>
      <p className="auth-note">
        Sign-ins and actions are recorded. <Link to="/privacy">Privacy notice</Link>
      </p>
    </AuthLayout>
  );
}

export default Login;
