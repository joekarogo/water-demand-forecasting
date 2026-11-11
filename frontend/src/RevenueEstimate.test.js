import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import RevenueEstimate from './RevenueEstimate';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const ANALYST_SESSION = {
  ...SAMPLE_SESSION,
  role: 'commercial_officer',
  role_label: 'Commercial Analyst',
  permissions: ['revenue:view'],
};

function sampleRevenue() {
  return {
    forecast_id: 9,
    published_at: '2026-10-25T10:00:00.000Z',
    data_up_to: '2024-08-01',
    subscribers_month: '2024-08-01',
    tariff_version_date: '2024-07-01',
    tariffs_in_use: {
      'KONUT ABONELERİ': [
        { min: 0, max: 4, waterPrice: 16.74, wastewaterPrice: 8.36 },
        { min: 4, max: 10, waterPrice: 32.35, wastewaterPrice: 16.17 },
      ],
    },
    months: [
      {
        month: '2024-09-01',
        share_years: [2023, 2022, 2021],
        totals: {
          water: { mid: 6_000_000, low: 5_500_000, high: 6_500_000 },
          wastewater: { mid: 3_000_000, low: 2_750_000, high: 3_250_000 },
          total: { mid: 9_000_000, low: 8_250_000, high: 9_750_000 },
          not_priced_volume_m3: 50_000,
          not_priced_pct: 5.0,
          not_priced_breakdown: [{ reason: 'unmapped', count: 2, volume_m3: 50_000 }],
        },
        by_group: [
          {
            customer_group: 'Konut',
            subscribers: 10000,
            volume_m3: 800_000,
            avg_use_m3: 8,
            water_try: 6_000_000,
            wastewater_try: 3_000_000,
            total_try: 9_000_000,
            average_price_per_m3: 11.25,
          },
        ],
        detail: [
          {
            district: 'Alpha',
            customer_group: 'Konut',
            subscribers: 10000,
            volume_m3: 800_000,
            avg_use_m3: 8,
            water_try: 6_000_000,
            wastewater_try: 3_000_000,
            total_try: 9_000_000,
          },
        ],
      },
      {
        month: '2024-10-01',
        share_years: [2023, 2022, 2021],
        totals: {
          water: { mid: 4_000_000, low: 3_600_000, high: 4_400_000 },
          wastewater: { mid: 2_000_000, low: 1_800_000, high: 2_200_000 },
          total: { mid: 6_000_000, low: 5_400_000, high: 6_600_000 },
          not_priced_volume_m3: 0,
          not_priced_pct: 0,
          not_priced_breakdown: [],
        },
        by_group: [
          {
            customer_group: 'Konut',
            subscribers: 10000,
            volume_m3: 600_000,
            avg_use_m3: 6,
            water_try: 4_000_000,
            wastewater_try: 2_000_000,
            total_try: 6_000_000,
            average_price_per_m3: 10,
          },
        ],
        detail: [
          {
            district: 'Alpha',
            customer_group: 'Konut',
            subscribers: 10000,
            volume_m3: 600_000,
            avg_use_m3: 6,
            water_try: 4_000_000,
            wastewater_try: 2_000_000,
            total_try: 6_000_000,
          },
        ],
      },
    ],
  };
}

function mockFetch(revenueBody) {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/revenue')) {
      return Promise.resolve(fakeResponse({ status: 200, body: revenueBody }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: ANALYST_SESSION }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <RevenueEstimate />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('renders the first forecast month with its KPIs', async () => {
  mockFetch(sampleRevenue());
  renderPage();

  await waitFor(() => expect(screen.getByText('Expected revenue')).toBeInTheDocument());

  expect(screen.getByText('Water charge')).toBeInTheDocument();
  expect(screen.getByText('Wastewater charge')).toBeInTheDocument();
  const expectedRevenueCard = screen.getByText('Expected revenue').closest('.kpi');
  expect(within(expectedRevenueCard).getByText('₺9.0M')).toBeInTheDocument();
});

test('changing the month updates the KPI cards', async () => {
  mockFetch(sampleRevenue());
  renderPage();

  const expectedRevenueCard = (await screen.findByText('Expected revenue')).closest('.kpi');
  await waitFor(() => expect(within(expectedRevenueCard).getByText('₺9.0M')).toBeInTheDocument());

  const monthSelect = screen.getByLabelText('Month');
  fireEvent.change(monthSelect, { target: { value: '1' } });

  await waitFor(() => expect(within(expectedRevenueCard).getByText('₺6.0M')).toBeInTheDocument());
});

test('KPI "Likely range" sub-lines use compact millions/billions formatting', async () => {
  const body = sampleRevenue();
  body.months[0].totals.total = { mid: 1_000_000_000, low: 955_300_000, high: 1_190_000_000 };
  mockFetch(body);
  renderPage();

  await waitFor(() => expect(screen.getByText('Expected revenue')).toBeInTheDocument());
  expect(screen.getByText('Likely range: ₺955.3M – ₺1.19B')).toBeInTheDocument();
});

test('customer-group table shows Water, Wastewater and Total in millions with one decimal', async () => {
  mockFetch(sampleRevenue());
  renderPage();

  const section = (await screen.findByText('Revenue by customer group')).closest('section');
  expect(within(section).getAllByText('₺6.0M').length).toBeGreaterThan(0);
  expect(within(section).getAllByText('₺3.0M').length).toBeGreaterThan(0);
  expect(within(section).getAllByText('₺9.0M').length).toBeGreaterThan(0);
});

test('group names with a gloss wrap onto two lines, and headers stay short and single-line', async () => {
  const body = sampleRevenue();
  body.months[0].by_group[0].customer_group = 'Tarım Hayvan';
  body.months[0].detail[0].customer_group = 'Tarım Hayvan';
  mockFetch(body);
  renderPage();

  const section = (await screen.findByText('Revenue by customer group')).closest('section');
  const table = within(section).getByRole('table');

  [
    'Customer group',
    'Subscribers',
    'Volume (m³)',
    'Not priced (m³)',
    'Avg use (m³)',
    'Water',
    'Wastewater',
    'Total',
    'Avg price (₺/m³)',
  ].forEach((label) => {
    expect(within(table).getByRole('button', { name: label })).toBeInTheDocument();
  });

  // The group name + English gloss wraps onto two lines (a <br>) instead of
  // forcing the column wide enough to fit both on one line.
  const groupCell = within(table).getAllByRole('rowheader')[0];
  expect(groupCell.querySelector('br')).toBeInTheDocument();
  expect(groupCell.textContent).toContain('Tarım Hayvan');
  expect(groupCell.textContent).toContain('Agriculture and livestock');
});

test('the not-priced card shows its percentage and reasons', async () => {
  mockFetch(sampleRevenue());
  renderPage();

  await waitFor(() => expect(screen.getByText('Not priced')).toBeInTheDocument());
  expect(screen.getByText('5.0%')).toBeInTheDocument();

  const infoBtn = screen.getByLabelText('Why is some volume not priced?');
  fireEvent.click(infoBtn);
  expect(screen.getByText(/no tariff mapping for this subscriber type/)).toBeInTheDocument();
});
