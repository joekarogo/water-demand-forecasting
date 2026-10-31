import AppLayout from './layout/AppLayout';
import { useSession } from './session';
import './App.css';

function Help() {
  const { session } = useSession();
  const permissions = session?.permissions || [];

  return (
    <AppLayout title="Help" subtitle="Task-focused guidance for this system">
      <section className="card" aria-labelledby="helpSignInTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="helpSignInTitle" style={{ marginBottom: 10 }}>
          Signing in and staying signed in
        </h2>
        <p style={{ margin: '0 0 10px' }}>
          Sign in with your registered Google account. If you're inactive for a while, you'll see a
          warning two minutes before your session ends, with the option to stay signed in. For
          security, every session ends after 8 hours regardless of activity.
        </p>
      </section>

      {permissions.includes('forecast:view') && (
        <section className="card" aria-labelledby="helpForecastTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpForecastTitle" style={{ marginBottom: 10 }}>
            Forecast
          </h2>
          <p style={{ margin: 0 }}>
            The shaded band is the model's 80% range. In past testing, actual demand fell inside it
            about 2 months in 3, and it fell below the range more often than above it, so treat the
            low end as optimistic. The upper end held about 9 months in 10, which is why the safe
            production plan uses it.
          </p>
        </section>
      )}

      {permissions.includes('plan:view') && (
        <section className="card" aria-labelledby="helpPlanningTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpPlanningTitle" style={{ marginBottom: 10 }}>
            Production planning
          </h2>
          <p style={{ margin: 0 }}>
            The "safe" plan uses the upper bound of the forecast range rather than the central
            forecast. In past testing, actual demand stayed below the safe plan in about 9 of 10
            months at a 1-month horizon, and about 8 of 10 months at a 12-month horizon.
          </p>
        </section>
      )}

      {permissions.includes('data:view') && (
        <section className="card" aria-labelledby="helpHistoricalTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpHistoricalTitle" style={{ marginBottom: 10 }}>
            Historical Analysis
          </h2>
          <p style={{ margin: 0 }}>
            Shows monthly billed water demand from January 2014 to August 2024, the data the
            forecast was trained on.
          </p>
        </section>
      )}

      {permissions.includes('user:manage') && (
        <section className="card" aria-labelledby="helpUsersTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpUsersTitle" style={{ marginBottom: 10 }}>
            Users
          </h2>
          <p style={{ margin: 0 }}>
            Admins can invite new users, change roles, set job titles, and deactivate or reactivate
            accounts. Changing a role, or deactivating/reactivating an account, needs a recent
            sign-in (within the last 10 minutes) — if you've been signed in a while, you'll be asked
            to sign in again before the change goes through.
          </p>
        </section>
      )}

      <section className="card" aria-labelledby="helpAccessTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="helpAccessTitle" style={{ marginBottom: 10 }}>
          Access problems
        </h2>
        <p style={{ margin: 0 }}>For access problems, contact your system administrator.</p>
      </section>
    </AppLayout>
  );
}

export default Help;
