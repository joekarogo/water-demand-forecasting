import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import { getFirstPermittedPath } from './layout/menuConfig';
import './App.css';

const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID;

function Login() {
  const location = useLocation();
  const navigate = useNavigate();
  const { refreshSession } = useSession();
  const googleButtonRef = useRef(null);

  const [error, setError] = useState(location.state?.message || '');

  // Google Identity Services renders its own button into this div once the
  // gsi/client script (loaded in public/index.html) is ready; we poll for
  // it rather than assume it has finished loading by the time we mount.
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    const handleCredential = async (response) => {
      setError('');
      try {
        const res = await apiFetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: response.credential }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data.error || "This Google account isn't authorised for this system. Contact your administrator.");
          return;
        }
        const me = await refreshSession();
        navigate(getFirstPermittedPath(me?.permissions || []), { replace: true });
      } catch (err) {
        setError('Unable to reach the server. Please try again.');
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
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Water Demand Forecasting</h1>

        {error && <p className="login-error">{error}</p>}

        {GOOGLE_CLIENT_ID ? (
          <div className="google-btn-wrap" ref={googleButtonRef} />
        ) : (
          <p className="login-error">
            Google sign-in isn't configured (missing REACT_APP_GOOGLE_CLIENT_ID).
          </p>
        )}

        <p className="login-note">
          We store your name, email and actions in this system for accountability.
        </p>
      </div>
    </div>
  );
}

export default Login;
