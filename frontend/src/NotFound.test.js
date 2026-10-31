import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from './session';
import NotFound from './NotFound';
import { fakeResponse } from './testFetchMock';

beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve(fakeResponse({ status: 401, body: { error: 'nope' } })));
});

// An unknown URL never silently redirects away — signed out, it shows a
// plain card pointing back at sign-in instead.
test('an unknown route shows a 404 card with a link to sign in, not a redirect', async () => {
  render(
    <MemoryRouter initialEntries={['/this-page-does-not-exist']}>
      <SessionProvider>
        <Routes>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>
  );

  await waitFor(() => expect(screen.getByText("This page doesn't exist.")).toBeInTheDocument());
  expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/login');
});

test('sets document.title to "Page not found · Water Demand Forecasting"', async () => {
  render(
    <MemoryRouter initialEntries={['/nope']}>
      <SessionProvider>
        <Routes>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>
  );

  await waitFor(() => expect(document.title).toBe('Page not found · Water Demand Forecasting'));
});
