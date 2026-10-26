import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from './apiClient';
import { useSession } from './session';
import { getFirstPermittedPath } from './layout/menuConfig';
import { AlertCircleIcon, ErrorTriangleIcon } from './layout/icons';
import AuthLayout from './AuthLayout';
import './App.css';

// Not linked from any nav — reached only by typing /emergency-login. Lets an
// emergency admin sign in with a password when Google sign-in is unavailable.
function EmergencyLogin() {
  const navigate = useNavigate();
  const { refreshSession } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await apiFetch('/api/auth/emergency-login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (response.status === 429) {
          setError(data.error || 'Too many attempts. Try again in 15 minutes.');
        } else {
          setError(data.error || 'Invalid email or password');
        }
        return;
      }

      const me = await refreshSession();
      navigate(getFirstPermittedPath(me?.permissions || []), { replace: true });
    } catch (err) {
      setError('Unable to reach the server. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout title="Emergency access">
      <div className="banner-amber">
        <ErrorTriangleIcon />
        <span>For system outages only. Every use is recorded and reviewed.</span>
      </div>

      <div className="msg-slot" role="alert">
        {error && (
          <div className="msg red">
            <AlertCircleIcon />
            <span>{error}</span>
          </div>
        )}
      </div>

      <form className="form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="emEmail">Email</label>
          <input
            className="input"
            type="email"
            id="emEmail"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="emPass">Password</label>
          <input
            className="input"
            type={showPassword ? 'text' : 'password'}
            id="emPass"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />
          Show password
        </label>
        <button type="submit" className="btn btn-primary btn-block" disabled={loading}>
          {loading ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <span>Signing in…</span>
            </>
          ) : (
            'Sign in'
          )}
        </button>
      </form>
    </AuthLayout>
  );
}

export default EmergencyLogin;
