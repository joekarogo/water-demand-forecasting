import { useEffect, useState } from 'react';
import AppLayout from './layout/AppLayout';
import { apiFetch } from './apiClient';
import { formatDateTime, formatMonthLong } from './utils/format';
import './App.css';

function About() {
  const [about, setAbout] = useState(null); // null = loading
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await apiFetch('/api/about');
        if (!response.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const body = await response.json();
        if (!cancelled) setAbout(body);
      } catch (err) {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <AppLayout title="About">
      <section className="card" aria-labelledby="aboutTitle" style={{ padding: 20 }}>
        <h2 className="card-title" id="aboutTitle" style={{ marginBottom: 14 }}>
          This system
        </h2>
        {error && <p className="field-err">Unable to load this information right now.</p>}
        {!error && about === null && <p className="field-hint">Loading…</p>}
        {!error && about && (
          <dl className="account-details">
            <div>
              <dt>Version</dt>
              <dd>{about.version}</dd>
            </div>
            <div>
              <dt>Data source</dt>
              <dd>İZSU Open Data (İzmir)</dd>
            </div>
            {about.data && (
              <div>
                <dt>Data range</dt>
                <dd>
                  {formatMonthLong(about.data.first_month)} – {formatMonthLong(about.data.last_month)}
                </dd>
              </div>
            )}
            {about.latest_forecast ? (
              <>
                <div>
                  <dt>Latest forecast published</dt>
                  <dd>{formatDateTime(about.latest_forecast.published_at)}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{about.latest_forecast.model_name}</dd>
                </div>
                {about.latest_forecast.horizon != null && (
                  <div>
                    <dt>Forecast horizon</dt>
                    <dd>
                      {about.latest_forecast.horizon} month{about.latest_forecast.horizon === 1 ? '' : 's'}
                    </dd>
                  </div>
                )}
                {about.latest_forecast.train_start && about.latest_forecast.train_end && (
                  <div>
                    <dt>Training data range</dt>
                    <dd>
                      {formatMonthLong(about.latest_forecast.train_start)} – {formatMonthLong(about.latest_forecast.train_end)}
                    </dd>
                  </div>
                )}
              </>
            ) : (
              <div>
                <dt>Latest forecast</dt>
                <dd>No forecast has been published yet.</dd>
              </div>
            )}
          </dl>
        )}
      </section>
    </AppLayout>
  );
}

export default About;
