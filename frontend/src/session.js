import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { apiFetch, setCsrfToken } from './apiClient';
import { clearSessionExpiry } from './sessionExpiry';

const SessionContext = createContext(undefined);

// The single source of truth for who is signed in: GET /api/me's result
// ({ user_id, name, email, role, role_label, permissions, csrf_token,
// session_expires_at }), fetched once on app load and again whenever
// something calls refreshSession (e.g. right after signing in). A 401
// (or any other failure) means signed out — session is null.
export function SessionProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshSession = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/me');
      if (!response.ok) {
        setSession(null);
        setCsrfToken(null);
        return null;
      }
      const body = await response.json();
      setSession(body);
      setCsrfToken(body.csrf_token || null);
      return body;
    } catch (err) {
      setSession(null);
      setCsrfToken(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const clearSession = useCallback(() => {
    setSession(null);
    setCsrfToken(null);
    clearSessionExpiry();
  }, []);

  // Used by the session-expiry "Stay signed in" button: updates only the
  // CSRF token and session_expires_at from a fresh GET /api/me response,
  // without setLoading(true) — unlike refreshSession, this never
  // unmounts the current page (AppLayout renders null while loading),
  // which would lose whatever the user was doing.
  const extendSession = useCallback((partial) => {
    setCsrfToken(partial.csrf_token || null);
    setSession((prev) =>
      prev ? { ...prev, csrf_token: partial.csrf_token, session_expires_at: partial.session_expires_at } : prev
    );
  }, []);

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  return (
    <SessionContext.Provider value={{ session, loading, refreshSession, clearSession, extendSession }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const context = useContext(SessionContext);
  if (context === undefined) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return context;
}
