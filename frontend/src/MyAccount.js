import { useEffect, useState } from 'react';
import AppLayout from './layout/AppLayout';
import { useSession } from './session';
import { apiFetch } from './apiClient';
import { formatDateTime } from './utils/format';
import './App.css';

function MyAccount() {
  const { session } = useSession();
  const [signIns, setSignIns] = useState(null); // null = loading
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await apiFetch('/api/me/sign-ins');
        if (!response.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const body = await response.json();
        if (!cancelled) setSignIns(body.sign_ins || []);
      } catch (err) {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppLayout title="My account" subtitle="Your account details and recent sign-ins">
      <section className="card" aria-labelledby="accountDetailsTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="accountDetailsTitle" style={{ marginBottom: 14 }}>
          Account details
        </h2>
        <dl className="account-details">
          <div>
            <dt>Name</dt>
            <dd>{session?.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{session?.email}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>{session?.role_label || session?.role}</dd>
          </div>
          {session?.job_title && (
            <div>
              <dt>Job title</dt>
              <dd>{session.job_title}</dd>
            </div>
          )}
          {session?.session_expires_at && (
            <div>
              <dt>Session ends</dt>
              <dd>{formatDateTime(session.session_expires_at)}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="card" aria-labelledby="signInsTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="signInsTitle" style={{ marginBottom: 14 }}>
          Recent sign-ins
        </h2>
        {error && <p className="field-err">Unable to load your sign-in history right now.</p>}
        {!error && signIns === null && <p className="field-hint">Loading…</p>}
        {!error && signIns !== null && signIns.length === 0 && (
          <p className="field-hint">No sign-ins recorded yet.</p>
        )}
        {!error && signIns && signIns.length > 0 && (
          <div className="table-wrap">
            <table className="plan-table">
              <caption className="sr-only">Your last {signIns.length} sign-ins.</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Method</th>
                  <th scope="col">IP address</th>
                </tr>
              </thead>
              <tbody>
                {signIns.map((row, i) => (
                  <tr key={i}>
                    <td>{formatDateTime(row.time)}</td>
                    <td>{row.method}</td>
                    <td>{row.ip_address || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </AppLayout>
  );
}

export default MyAccount;
