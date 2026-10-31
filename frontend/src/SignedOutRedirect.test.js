import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from './session';
import DemandByDistrict from './DemandByDistrict';
import RevenueEstimate from './RevenueEstimate';
import Users from './Users';
import ProductionPlanning from './ProductionPlanning';
import { fakeResponse } from './testFetchMock';

// Each of these pages used to `return null` before ever rendering
// AppLayout when there was no session, which meant AppLayout's own
// redirect-to-/login effect never got a chance to run. A signed-out
// visitor landed on a blank page instead of being sent to sign in.
beforeEach(() => {
  global.fetch = jest.fn(() => Promise.resolve(fakeResponse({ status: 401, body: { error: 'Not signed in.' } })));
});

function renderAt(path, Page) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>
        <Routes>
          <Route path={path} element={<Page />} />
          <Route path="/login" element={<div>Login page probe</div>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>
  );
}

test('a signed-out visit to /demand-by-district ends on /login', async () => {
  renderAt('/demand-by-district', DemandByDistrict);
  await waitFor(() => expect(screen.getByText('Login page probe')).toBeInTheDocument());
});

test('a signed-out visit to /revenue ends on /login', async () => {
  renderAt('/revenue', RevenueEstimate);
  await waitFor(() => expect(screen.getByText('Login page probe')).toBeInTheDocument());
});

test('a signed-out visit to /users ends on /login', async () => {
  renderAt('/users', Users);
  await waitFor(() => expect(screen.getByText('Login page probe')).toBeInTheDocument());
});

test('a signed-out visit to /production-planning ends on /login', async () => {
  renderAt('/production-planning', ProductionPlanning);
  await waitFor(() => expect(screen.getByText('Login page probe')).toBeInTheDocument());
});
