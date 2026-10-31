import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import DemandByDistrict from './DemandByDistrict';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const PLANNER_SESSION = {
  ...SAMPLE_SESSION,
  role: 'production_manager',
  role_label: 'Production Planner',
  permissions: ['distribution:view', 'plan:view'],
};

function sampleDistribution() {
  return {
    forecast_id: 7,
    published_at: '2026-10-25T10:00:00.000Z',
    data_up_to: '2024-08-01',
    loss_rate: 0.324,
    loss_rate_source: 'database/schema/001_foundation.sql',
    districts: ['Alpha', 'Beta'],
    subscribers_month: '2024-08-01',
    swing: { district: 'Beta', ratio: 3, highMonth: 8, lowMonth: 2 },
    months: [
      {
        month: '2024-09-01',
        share_years: [2023, 2022, 2021],
        change_years: [2023, 2022],
        plan_type: 'safe',
        plan_chosen_m3: 1_000_000,
        districts: [
          {
            district: 'Alpha',
            share_pct: 60.0,
            forecast_m3: 600_000,
            lower_m3: 500_000,
            upper_m3: 700_000,
            allocation_m3: 600_000,
            share_change_pts: 1.5,
            subscribers: 1000,
          },
          {
            district: 'Beta',
            share_pct: 40.0,
            forecast_m3: 400_000,
            lower_m3: 300_000,
            upper_m3: 500_000,
            allocation_m3: 400_000,
            share_change_pts: -1.5,
            subscribers: 500,
          },
        ],
      },
      {
        month: '2024-10-01',
        share_years: [2023, 2022, 2021],
        change_years: [2023, 2022],
        plan_type: null,
        plan_chosen_m3: null,
        districts: [
          {
            district: 'Alpha',
            share_pct: 55.0,
            forecast_m3: 550_000,
            lower_m3: 450_000,
            upper_m3: 650_000,
            allocation_m3: null,
            share_change_pts: 0.2,
            subscribers: 1000,
          },
          {
            district: 'Beta',
            share_pct: 45.0,
            forecast_m3: 450_000,
            lower_m3: 350_000,
            upper_m3: 550_000,
            allocation_m3: null,
            share_change_pts: -0.2,
            subscribers: 500,
          },
        ],
      },
    ],
  };
}

function mockFetch(distributionBody) {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/distribution')) {
      return Promise.resolve(fakeResponse({ status: 200, body: distributionBody }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: PLANNER_SESSION }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <DemandByDistrict />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('renders the first forecast month with its KPIs', async () => {
  mockFetch(sampleDistribution());
  renderPage();

  await waitFor(() => expect(screen.getByText('Districts covered')).toBeInTheDocument());

  expect(screen.getByText('Largest district')).toBeInTheDocument();
  expect(screen.getAllByText('Alpha').length).toBeGreaterThan(0);

  const districtsCard = screen.getByText('Districts covered').closest('.kpi');
  expect(within(districtsCard).getByText('2')).toBeInTheDocument();

  const swingCard = screen.getByText('Biggest seasonal swing').closest('.kpi');
  expect(within(swingCard).getByText('Beta')).toBeInTheDocument();
});

test('changing the month updates the KPI cards and shows the no-plan note', async () => {
  mockFetch(sampleDistribution());
  renderPage();

  await waitFor(() => expect(screen.getByText('Districts covered')).toBeInTheDocument());

  // First month (Sep 2024) has a saved plan, so the no-plan note is absent.
  expect(screen.queryByText(/No production plan saved for this month/)).not.toBeInTheDocument();

  const monthSelect = screen.getByLabelText('Month');
  fireEvent.change(monthSelect, { target: { value: '1' } });

  await waitFor(() =>
    expect(screen.getByText(/No production plan saved for this month/)).toBeInTheDocument()
  );
  expect(screen.getByText('No plan saved')).toBeInTheDocument();
});

test('sorting the table by a column reverses the row order', async () => {
  mockFetch(sampleDistribution());
  renderPage();

  await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

  const table = screen.getByRole('table');
  const bodyRowName = () => within(table).getAllByRole('row')[1].textContent;

  // Default sort is forecast (desc): Alpha (600,000) before Beta (400,000).
  expect(bodyRowName()).toMatch(/^Alpha/);

  const forecastHeaderBtn = within(table).getByRole('button', { name: /Forecast billed/ });
  fireEvent.click(forecastHeaderBtn); // desc -> asc
  await waitFor(() => expect(bodyRowName()).toMatch(/^Beta/));
});
