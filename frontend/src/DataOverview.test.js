import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import DataOverview from './DataOverview';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const DATA_VIEW_SESSION = {
  ...SAMPLE_SESSION,
  role: 'admin',
  role_label: 'Admin',
  permissions: ['data:view'],
};

// A small 4-month fixture — enough to exercise the date range, months-of-data
// count, average and peak-month cards without hand-computing a 128-month series.
const HISTORY = [
  { date: '2024-05-01', consumption_m3: 18_000_000 },
  { date: '2024-06-01', consumption_m3: 20_000_000 },
  { date: '2024-07-01', consumption_m3: 24_000_000 },
  { date: '2024-08-01', consumption_m3: 22_000_000 },
];

function mockFetch() {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/consumption-history')) {
      return Promise.resolve(fakeResponse({ status: 200, body: { data: HISTORY } }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: DATA_VIEW_SESSION }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <DataOverview />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('shows live card figures from the fetched history, not hardcoded ones', async () => {
  mockFetch();
  renderPage();

  await screen.findByText('Date range');

  // Months of data, not "Total Records" — the fixture has 4 rows.
  expect(screen.getByText('Months of data')).toBeInTheDocument();
  expect(screen.queryByText('Total Records')).not.toBeInTheDocument();
  expect(screen.getByText('4')).toBeInTheDocument();

  // Date range card: May 2024 – Aug 2024, derived live from the fixture.
  expect(screen.getByText('May 2024 – Aug 2024')).toBeInTheDocument();

  // Average monthly demand: (18M + 20M + 24M + 22M) / 4 = 21,000,000 m3.
  expect(screen.getByText('21,000,000')).toBeInTheDocument();

  // Peak month: Jul 2024 at 24,000,000 m3.
  expect(screen.getByText('Jul 2024')).toBeInTheDocument();
  expect(screen.getByText('24,000,000 m³')).toBeInTheDocument();
});

test('uses m³ everywhere and never the unescaped "m3"', async () => {
  mockFetch();
  renderPage();

  await screen.findByText('Date range');

  expect(screen.queryByText(/\bm3\b/)).not.toBeInTheDocument();
  expect(screen.getAllByText(/m³/).length).toBeGreaterThan(0);
});

test('chart title shows the live first/last month and the smoothing note renders', async () => {
  mockFetch();
  renderPage();

  await screen.findByText('Date range');

  expect(screen.getByText('Monthly billed water demand, May 2024 – Aug 2024')).toBeInTheDocument();
  expect(
    screen.getByText(
      'Five unusual months (the September 2019 billing spike, April–June and August 2020 during COVID) were smoothed before training; the chart shows the cleaned data.'
    )
  ).toBeInTheDocument();
});
