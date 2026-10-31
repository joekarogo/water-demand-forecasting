import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import AppLayout from './layout/AppLayout';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve(fakeResponse({ status: 200, body: SAMPLE_SESSION })));
});

test('the first focusable element is a "Skip to main content" link targeting #main-content', async () => {
  render(
    <MemoryRouter>
      <SessionProvider>
        <AppLayout title="Demand Forecast">
          <p>Page content</p>
        </AppLayout>
      </SessionProvider>
    </MemoryRouter>
  );

  await waitFor(() => expect(screen.getByText('Page content')).toBeInTheDocument());

  const skipLink = screen.getByRole('link', { name: 'Skip to main content' });
  expect(skipLink).toHaveAttribute('href', '#main-content');
  const main = document.getElementById('main-content');
  expect(main).not.toBeNull();
  expect(main.tagName).toBe('MAIN');
});

test('sets document.title to "<page title> · Water Demand Forecasting"', async () => {
  render(
    <MemoryRouter>
      <SessionProvider>
        <AppLayout title="Demand Forecast">
          <p>Page content</p>
        </AppLayout>
      </SessionProvider>
    </MemoryRouter>
  );

  await waitFor(() => expect(document.title).toBe('Demand Forecast · Water Demand Forecasting'));
});
