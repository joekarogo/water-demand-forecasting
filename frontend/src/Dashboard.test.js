import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import Dashboard from './Dashboard';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

// 12 forecast months, each with a matching "same month last year" row in
// history so Change/last-year figures are never the null/em-dash branch.
const FORECAST_MONTHS = [
  '2024-09-01', '2024-10-01', '2024-11-01', '2024-12-01',
  '2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01',
  '2025-05-01', '2025-06-01', '2025-07-01', '2025-08-01',
];
const HISTORY_MONTHS = [
  '2023-09-01', '2023-10-01', '2023-11-01', '2023-12-01',
  '2024-01-01', '2024-02-01', '2024-03-01', '2024-04-01',
  '2024-05-01', '2024-06-01', '2024-07-01', '2024-08-01',
];

function forecastBody(modelName) {
  return {
    published_at: '2026-10-25T10:00:00.000Z',
    model_name: modelName,
    train_start: '2014-01-01',
    train_end: '2024-08-01',
    data_up_to: '2024-08-01',
    interval_width: 0.8,
    metrics: { mae: 892175.3, rmse: 1190331.2, mape: 4.0993109733 },
    loss_rate: 0.12,
    loss_rate_source: 'settings table',
    forecast: FORECAST_MONTHS.map((date, i) => ({
      date,
      yhat: 20_000_000 + i * 500_000,
      yhat_lower: 18_500_000 + i * 500_000,
      yhat_upper: 21_500_000 + i * 500_000,
    })),
    history: HISTORY_MONTHS.map((date, i) => ({ date, actual: 19_000_000 + i * 400_000 })),
  };
}

function mockFetch(body) {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/forecast/published')) {
      return Promise.resolve(fakeResponse({ status: 200, body }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: SAMPLE_SESSION }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <Dashboard />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('shows no show-next selector or range/last-year toggles', async () => {
  mockFetch(forecastBody('Ensemble (Prophet + SARIMA, 50/50)'));
  renderPage();

  await screen.findByText('Monthly forecast');

  expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  expect(screen.queryByText(/show next/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(screen.queryByText('Show 80% range')).not.toBeInTheDocument();
  expect(screen.queryByText('Show same months last year')).not.toBeInTheDocument();
});

test('the table always shows exactly 12 months, with the new column order', async () => {
  mockFetch(forecastBody('Ensemble (Prophet + SARIMA, 50/50)'));
  renderPage();

  await screen.findByText('Monthly forecast');

  const table = screen.getByRole('table');
  const headers = within(table).getAllByRole('columnheader').map((th) => th.textContent);
  expect(headers).toEqual(['Month', 'Forecast', 'Same month last year', 'Change', 'Likely range']);

  const rows = within(table).getAllByRole('row');
  expect(rows.length).toBe(13); // 1 header row + 12 month rows
});

test('card 3 is labelled "Average error", with a plain percentage (no ±) and the new help text', async () => {
  mockFetch(forecastBody('Ensemble (Prophet + SARIMA, 50/50)'));
  renderPage();

  await screen.findByText('Average error');
  expect(screen.queryByText('Forecast accuracy')).not.toBeInTheDocument();

  const card = screen.getByText('Average error').closest('.kpi');
  expect(card).toHaveTextContent('4.1%');
  expect(card).not.toHaveTextContent('±');
  expect(within(card).getByText('on 26 months the model never saw')).toBeInTheDocument();
});

test('footer shows the trained-months count and the Ensemble-specific tip when model_name contains "Ensemble"', async () => {
  mockFetch(forecastBody('Ensemble (Prophet + SARIMA, 50/50)'));
  renderPage();

  await screen.findByText(/Model: Ensemble/);
  expect(screen.getByText(/\(\d+ months\)/)).toBeInTheDocument();
  expect(
    screen.getByText(/Two models, Prophet and SARIMA, learn the trend and the summer\/winter pattern/)
  ).toBeInTheDocument();
});

test('footer falls back to the generic model tip when model_name is not the ensemble', async () => {
  mockFetch(forecastBody('Prophet (default settings)'));
  renderPage();

  await screen.findByText(/Model: Prophet/);
  expect(screen.getByText('The model learns the trend and the summer/winter pattern from past billed demand.')).toBeInTheDocument();
  expect(screen.queryByText(/Two models, Prophet and SARIMA/)).not.toBeInTheDocument();
});

test('Export CSV saves a Blob via the shared download helper', async () => {
  mockFetch(forecastBody('Ensemble (Prophet + SARIMA, 50/50)'));
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = jest.fn();
  const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  renderPage();
  await screen.findByText('Monthly forecast');

  const exportButton = screen.getByRole('button', { name: /Export CSV/i });
  fireEvent.click(exportButton);

  expect(clickSpy).toHaveBeenCalled();
  expect(global.URL.createObjectURL).toHaveBeenCalled();
  expect(global.URL.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);

  clickSpy.mockRestore();
});
