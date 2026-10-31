import { useSession } from './session';
import AppLayout from './layout/AppLayout';
import { BrandIcon } from './layout/icons';
import { useDocumentTitle } from './useDocumentTitle';
import './App.css';

// Shared between the signed-in (inside AppLayout) and signed-out (plain
// card, reachable from the sign-in page) variants below — same content
// either way. Every statement here is a fact about this codebase
// (database/schema/*.sql, backend/app.js's cookie/session handling,
// frontend/public/index.html's font/Google Sign-In script tags), not a
// legal claim.
function PrivacyContent() {
  return (
    <>
      <section className="card" aria-labelledby="privacyStoresTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="privacyStoresTitle" style={{ marginBottom: 10 }}>
          What this system stores
        </h2>
        <p style={{ margin: '0 0 10px' }}>
          For each user account: name, email address, Google account ID, role, job title (if set),
          account status, and last sign-in time.
        </p>
        <p style={{ margin: '0 0 10px' }}>For each session: an entry recording the IP address it was created from.</p>
        <p style={{ margin: 0 }}>
          An audit log of actions taken in the system (such as sign-ins, role changes, and
          permission checks), each with the IP address it came from.
        </p>
      </section>

      <section className="card" aria-labelledby="privacyWhyTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="privacyWhyTitle" style={{ marginBottom: 10 }}>
          Why
        </h2>
        <p style={{ margin: 0 }}>
          This information is kept for accountability and security — to know who did what, and to
          help detect and investigate misuse.
        </p>
      </section>

      <section className="card" aria-labelledby="privacyCookiesTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="privacyCookiesTitle" style={{ marginBottom: 10 }}>
          Cookies
        </h2>
        <p style={{ margin: 0 }}>
          This system sets one strictly necessary cookie to keep you signed in. Google's sign-in
          button also stores a small cookie of its own (g_state). Neither is used for tracking or
          advertising.
        </p>
      </section>

      <section className="card" aria-labelledby="privacyThirdPartyTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="privacyThirdPartyTitle" style={{ marginBottom: 10 }}>
          Third parties
        </h2>
        <p style={{ margin: 0 }}>
          Signing in uses Google Sign-In, and this page's typeface loads from Google Fonts — both
          load directly from Google.
        </p>
      </section>

      <section className="card" aria-labelledby="privacyForecastTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="privacyForecastTitle" style={{ marginBottom: 10 }}>
          Forecast data
        </h2>
        <p style={{ margin: 0 }}>
          The water demand forecast is based on aggregated, publicly published open data and
          contains no customer personal data.
        </p>
      </section>

      <section className="card" aria-labelledby="privacyAuditTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="privacyAuditTitle" style={{ marginBottom: 10 }}>
          Audit log
        </h2>
        <p style={{ margin: 0 }}>Audit log entries cannot be edited or deleted.</p>
      </section>

      <section className="card" aria-labelledby="privacyRetentionTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="privacyRetentionTitle" style={{ marginBottom: 10 }}>
          Retention
        </h2>
        <p style={{ margin: 0 }}>How long this information is kept is set by the organisation operating the system.</p>
      </section>
    </>
  );
}

function Privacy() {
  const { session, loading } = useSession();
  useDocumentTitle('Privacy notice');

  if (loading) return null;

  if (!session) {
    return (
      <div className="auth-page">
        <div className="auth-card" style={{ maxWidth: 560, textAlign: 'left' }}>
          <div className="logo-row">
            <span className="brand-icon" aria-hidden="true">
              <BrandIcon />
            </span>
            <span>Water Demand Forecasting</span>
          </div>
          <main id="main-content" tabIndex="-1" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <h1>Privacy notice</h1>
            <PrivacyContent />
          </main>
        </div>
      </div>
    );
  }

  return (
    <AppLayout title="Privacy notice">
      <PrivacyContent />
    </AppLayout>
  );
}

export default Privacy;
