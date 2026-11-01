import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import Overview from './Overview';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const ADMIN_SESSION = {
  ...SAMPLE_SESSION,
  role: 'admin',
  role_label: 'Admin',
  permissions: ['forecast:view', 'user:manage'],
};
const PLANNER_SESSION = {
  ...SAMPLE_SESSION,
  role: 'production_manager',
  role_label: 'Production Planner',
  permissions: ['forecast:view', 'plan:view', 'distribution:view'],
};
const ANALYST_SESSION = {
  ...SAMPLE_SESSION,
  role: 'commercial_officer',
  role_label: 'Commercial Analyst',
  permissions: ['forecast:view', 'revenue:view'],
};

const COMMON = {
  first_month: '2026-11-01',
  data_up_to: '2024-08-01',
  thresholds: {
    days_of_cover_warning_days: 30,
    days_of_cover_alert_days: 15,
    stock_stale_days: 30,
    not_priced_pct_warning: 5,
    emergency_login_window_days: 30,
    audit_window_days: 7,
  },
};

function adminOverview() {
  return {
    ...COMMON,
    published_at: '2026-10-25T10:00:00.000Z',
    alerts: [
      {
        level: 'warning',
        message: '1 failed sign-in attempt in the last 7 days.',
        link: '/activity-log?category=failed_sign_in&days=7',
        linkText: 'Open Activity log',
      },
    ],
    sections: {
      forecast: {
        first_month: '2026-11-01',
        predicted: 25_000_000,
        lower: 23_000_000,
        upper: 27_000_000,
        published_at: '2026-10-25T10:00:00.000Z',
        data_up_to: '2024-08-01',
      },
      users: {
        active_by_role: [{ role_label: 'Admin', count: 1 }],
        invited_never_signed_in: [],
        sign_ins_last_7_days: 3,
        failed_attempts_last_7_days: 1,
        permission_denied_last_7_days: 0,
        last_emergency_login_at: null,
        recent_events: [{ time: '2026-10-30T09:00:00.000Z', actor_name: 'Ada Lovelace', action: 'login.success', label: 'Signed in' }],
      },
    },
  };
}

function plannerOverview() {
  return {
    ...COMMON,
    alerts: [],
    sections: {
      forecast: {
        first_month: '2026-11-01',
        predicted: 25_000_000,
        lower: 23_000_000,
        upper: 27_000_000,
        published_at: '2026-10-25T10:00:00.000Z',
        data_up_to: '2024-08-01',
      },
      production: {
        next_months: [{ month: '2026-11-01', plan: { plan_type: 'safe', chosen_m3: 27_000_000 } }],
        all_months: [{ month: '2026-11-01', forecast_m3: 25_000_000, has_plan: true }],
        latest_stock: { recorded_on: '2026-10-29', stock_m3: 1_000_000 },
        days_of_cover: 40,
      },
      distribution: { month: '2026-11-01', district: 'Buca', share_pct: 12.3, forecast_m3: 3_000_000 },
    },
  };
}

function analystOverview() {
  return {
    ...COMMON,
    alerts: [],
    sections: {
      forecast: {
        first_month: '2026-11-01',
        predicted: 25_000_000,
        lower: 23_000_000,
        upper: 27_000_000,
        published_at: '2026-10-25T10:00:00.000Z',
        data_up_to: '2024-08-01',
      },
      revenue: {
        month: '2026-11-01',
        total: { mid: 50_000_000, low: 45_000_000, high: 55_000_000 },
        twelve_month_total_mid: 600_000_000,
        housing_share_pct: 60,
        average_price_per_m3: 20,
        not_priced_pct: 2,
        tariff_version_date: '2024-07-01',
        months: [{ month: '2026-11-01', total_mid: 50_000_000 }],
      },
    },
  };
}

function mockFetch(session, overviewBody) {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/overview')) {
      return Promise.resolve(fakeResponse({ status: 200, body: overviewBody }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: session }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <Overview />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('an Admin session shows only admin sections', async () => {
  mockFetch(ADMIN_SESSION, adminOverview());
  renderPage();

  await waitFor(() => expect(screen.getByText('Recent activity')).toBeInTheDocument());
  expect(screen.getByText('Active users')).toBeInTheDocument();
  expect(screen.queryByText('12-month forecast')).not.toBeInTheDocument();
  expect(screen.queryByText('12-month revenue')).not.toBeInTheDocument();

  // Now that the Activity log page exists, this alert links there,
  // pre-filtered to failed sign-ins in the last 7 days.
  const alertLink = screen.getByRole('link', { name: /failed sign-in attempt/i });
  expect(alertLink).toHaveAttribute('href', '/activity-log?category=failed_sign_in&days=7');
  expect(within(alertLink).getByText('Open Activity log')).toBeInTheDocument();
});

test('a Production Planner session shows only production sections', async () => {
  mockFetch(PLANNER_SESSION, plannerOverview());
  renderPage();

  await waitFor(() => expect(screen.getByText('12-month forecast')).toBeInTheDocument());
  expect(screen.getByText('Days of stock remaining')).toBeInTheDocument();
  expect(screen.getByText('Largest district')).toBeInTheDocument();
  expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
  expect(screen.queryByText('12-month revenue')).not.toBeInTheDocument();
  expect(screen.getByText('Nothing needs your attention.')).toBeInTheDocument();
});

test('a Commercial Analyst session shows only revenue sections', async () => {
  mockFetch(ANALYST_SESSION, analystOverview());
  renderPage();

  await waitFor(() => expect(screen.getByText('12-month revenue')).toBeInTheDocument());
  expect(screen.getByText('Expected revenue')).toBeInTheDocument();
  expect(screen.getByText('Not priced')).toBeInTheDocument();
  expect(screen.queryByText('12-month forecast')).not.toBeInTheDocument();
  expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
});

test('an Admin session gets a 4th "Latest forecast" KPI card, with no empty gap', async () => {
  mockFetch(ADMIN_SESSION, adminOverview());
  renderPage();

  await waitFor(() => expect(screen.getByText('Latest forecast')).toBeInTheDocument());
  const kpis = screen.getByLabelText('Key figures');
  expect(within(kpis).getAllByText(/./, { selector: '.kpi-label' }).length).toBe(4);

  // published_at is a full ISO timestamp (TIMESTAMPTZ since migration 009),
  // not a bare "YYYY-MM-DD" date — this must format as "25 Oct 2026", not "NaN Oct 2026".
  const card = screen.getByText('Latest forecast').closest('.kpi');
  expect(within(card).getByText('25 Oct 2026')).toBeInTheDocument();
});

test('a Commercial Analyst session gets a 4th "Next 12 months" KPI card, with no empty gap', async () => {
  mockFetch(ANALYST_SESSION, analystOverview());
  renderPage();

  await waitFor(() => expect(screen.getByText('Next 12 months')).toBeInTheDocument());
  const kpis = screen.getByLabelText('Key figures');
  expect(within(kpis).getAllByText(/./, { selector: '.kpi-label' }).length).toBe(4);
});

test('an alert with a link shows visible link text at the end', async () => {
  const body = adminOverview();
  body.alerts = [
    { level: 'info', message: "Kate has been invited but hasn't signed in yet.", link: '/users', linkText: 'Open Users' },
  ];
  mockFetch(ADMIN_SESSION, body);
  renderPage();

  const alertLink = await screen.findByRole('link', { name: /Kate has been invited/i });
  expect(within(alertLink).getByText('Open Users')).toBeInTheDocument();
});

test('an alert with no link renders as plain text, not a link', async () => {
  const body = adminOverview();
  body.alerts = [{ level: 'info', message: 'A purely informational alert with nowhere to go.' }];
  mockFetch(ADMIN_SESSION, body);
  renderPage();

  await waitFor(() => expect(screen.getByText(/A purely informational alert/i)).toBeInTheDocument());
  expect(screen.queryByRole('link', { name: /A purely informational alert/i })).not.toBeInTheDocument();
});

test('the failed-attempts and emergency-sign-in alerts both link to the Activity log, pre-filtered', async () => {
  const body = adminOverview();
  body.alerts = [
    {
      level: 'warning',
      message: '2 failed sign-in attempts in the last 7 days.',
      link: '/activity-log?category=failed_sign_in&days=7',
      linkText: 'Open Activity log',
    },
    {
      level: 'warning',
      message: 'An emergency sign-in happened in the last 30 days.',
      link: '/activity-log?category=emergency&days=30',
      linkText: 'Open Activity log',
    },
  ];
  mockFetch(ADMIN_SESSION, body);
  renderPage();

  const failedLink = await screen.findByRole('link', { name: /2 failed sign-in attempts/i });
  expect(failedLink).toHaveAttribute('href', '/activity-log?category=failed_sign_in&days=7');

  const emergencyLink = screen.getByRole('link', { name: /An emergency sign-in happened/i });
  expect(emergencyLink).toHaveAttribute('href', '/activity-log?category=emergency&days=30');
});

test('an invited-never-signed-in alert names the person', async () => {
  const body = adminOverview();
  body.alerts = [
    { level: 'info', message: "Kate has been invited but hasn't signed in yet.", link: '/users', linkText: 'Open Users' },
  ];
  mockFetch(ADMIN_SESSION, body);
  renderPage();

  expect(await screen.findByText(/^Kate has been invited but hasn't signed in yet\.$/)).toBeInTheDocument();
});

test("the subtitle names the first forecast month, and the KPI section shows at most 4 cards", async () => {
  mockFetch(ADMIN_SESSION, adminOverview());
  renderPage();

  await waitFor(() => expect(screen.getByText('Your summary for November 2026')).toBeInTheDocument());
  const kpis = screen.getByLabelText('Key figures');
  expect(within(kpis).getAllByText(/./, { selector: '.kpi-label' }).length).toBeLessThanOrEqual(4);
});
