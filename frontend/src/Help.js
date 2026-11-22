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

      <section className="card" aria-labelledby="helpOverviewTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="helpOverviewTitle" style={{ marginBottom: 10 }}>
          Overview
        </h2>
        <p style={{ margin: 0 }}>
          Your Overview page is the first thing you see after signing in. "Needs your attention"
          lists anything worth checking right now — each item links straight to the page where you
          can act on it. The rest of the page shows a short summary built from whichever pages your
          permissions let you see; it never shows anything you couldn't already see elsewhere.
        </p>
      </section>

      {permissions.includes('forecast:view') && (
        <section className="card" aria-labelledby="helpForecastTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpForecastTitle" style={{ marginBottom: 10 }}>
            Forecast
          </h2>
          <p style={{ margin: 0 }}>
            The forecast covers the next 12 months. The shaded band is the likely range: in past
            testing, actual demand landed inside it about 8–9 months in 10, and the safe production
            plan uses its top. The grey line shows the same month last year, so you can see whether
            demand is expected to be higher or lower.
          </p>
        </section>
      )}

      {permissions.includes('forecast:view') && (
        <section className="card" aria-labelledby="helpEvaluationTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpEvaluationTitle" style={{ marginBottom: 10 }}>
            Model evaluation
          </h2>
          <p style={{ margin: 0 }}>
            Shows how accurate the forecast has actually been, from the project's own test results — it never
            retrains or re-evaluates anything live. If a particular result wasn't stored, that section says so
            rather than guessing, and the page is explicit about which model differences are statistically
            significant and which could just be chance.
          </p>
        </section>
      )}

      {permissions.includes('plan:view') && (
        <section className="card" aria-labelledby="helpPlanningTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpPlanningTitle" style={{ marginBottom: 10 }}>
            Production planning
          </h2>
          <p style={{ margin: '0 0 10px' }}>
            The "safe" plan uses the upper end of the likely range rather than the central
            forecast. In past testing, actual demand stayed below the safe plan in about 9 of 10
            months at a 1-month horizon, and about 8 of 10 months at a 12-month horizon.
          </p>
          <p style={{ margin: 0 }}>
            A stored water reading is a daily snapshot of usable water held in storage, not a
            production figure — only one reading is kept per date. Correcting or removing a reading
            needs a reason and is kept in the activity log, never just overwritten or deleted. A
            reading above the total usable storage capacity is rejected, and a reading more than 25%
            different from the previous one asks you to confirm it's correct before saving.
          </p>
        </section>
      )}

      {permissions.includes('distribution:view') && (
        <section className="card" aria-labelledby="helpDistrictTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpDistrictTitle" style={{ marginBottom: 10 }}>
            Demand by district
          </h2>
          <p style={{ margin: 0 }}>
            District figures split the published city forecast by each district's recent historical
            share, so about 5% of a month's water typically lands in the wrong district. Districts are
            administrative areas, not actual water supply zones, so figures show expected billed demand
            rather than pipe routing. One loss rate is applied to every district alike, even though real
            losses vary by district.
          </p>
        </section>
      )}

      {permissions.includes('revenue:view') && (
        <section className="card" aria-labelledby="helpRevenueTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpRevenueTitle" style={{ marginBottom: 10 }}>
            Revenue estimate
          </h2>
          <p style={{ margin: 0 }}>
            These figures are a lower bound: pricing the average customer under rising price steps undercounts what
            heavier users actually pay. They use the latest published tariff (1 July 2024) and exclude taxes, so
            real income will differ, especially after any later price change.
          </p>
        </section>
      )}

      {permissions.includes('revenue:view') && (
        <section className="card" aria-labelledby="helpScenariosTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpScenariosTitle" style={{ marginBottom: 10 }}>
            Revenue scenarios
          </h2>
          <p style={{ margin: 0 }}>
            Compare up to two "what if prices changed" scenarios against the baseline, live — nothing here is saved.
            A demand-response setting models customers using a little less water as prices rise, using price
            elasticity figures from international research on residential water demand, not measurements from
            İzmir. This is a simplified, constant-elasticity approximation, and the same lower-bound caveat as
            Revenue estimate still applies.
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

      {(permissions.includes('audit:view_all') || permissions.includes('audit:view_own')) && (
        <section className="card" aria-labelledby="helpActivityTitle" style={{ padding: 20 }}>
          <h2 className="card-title" id="helpActivityTitle" style={{ marginBottom: 10 }}>
            Activity log
          </h2>
          <p style={{ margin: 0 }}>
            {permissions.includes('audit:view_all')
              ? 'Admins can see everything that happened in the system: who signed in, who was invited or had their role changed, failed sign-in attempts, and more.'
              : 'You can see your own activity in the system — your sign-ins and anything you changed.'}{' '}
            Entries are recorded automatically and can't be edited or deleted. Filter by date, category
            or a search term, and export the results as a CSV file.
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
