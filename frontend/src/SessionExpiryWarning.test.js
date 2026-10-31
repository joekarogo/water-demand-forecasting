import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { SessionProvider } from './session';
import SessionExpiryWarning from './SessionExpiryWarning';
import { setSessionExpiryFromHeaders, clearSessionExpiry } from './sessionExpiry';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

afterEach(() => {
  clearSessionExpiry();
  jest.useRealTimers();
});

// Renders whatever navigate(..., { state: { message } }) lands on, so a
// test can assert on the exact message a sign-out/expiry redirect used.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="nav-message">{location.state?.message || ''}</div>;
}

test('shows an alertdialog with a countdown once under 2 minutes remain, and "Stay signed in" extends it', async () => {
  jest.useFakeTimers('modern');

  global.fetch = jest.fn(() =>
    Promise.resolve(
      fakeResponse({
        status: 200,
        body: SAMPLE_SESSION,
        headers: { 'X-Session-Expires-In': '3600', 'X-Session-Max-Reached': 'false' },
      })
    )
  );

  await act(async () => {
    render(
      <MemoryRouter>
        <SessionProvider>
          <SessionExpiryWarning />
        </SessionProvider>
      </MemoryRouter>
    );
    // let SessionProvider's own mount-time GET /api/me resolve first.
    await Promise.resolve();
    await Promise.resolve();
  });

  // 90 seconds left — inside the 2-minute warning window.
  act(() => {
    setSessionExpiryFromHeaders({ get: (name) => (name === 'X-Session-Expires-In' ? '90' : 'false') });
  });

  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent(/your session will end in 1:30/i);

  const staySignedInBtn = screen.getByRole('button', { name: 'Stay signed in' });
  expect(staySignedInBtn).toHaveFocus();

  await act(async () => {
    staySignedInBtn.click();
    // flush the apiFetch('/api/me') promise chain under fake timers.
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('shows the 8-hour-cap message with only an OK button when X-Session-Max-Reached is true', async () => {
  jest.useFakeTimers('modern');
  global.fetch = jest.fn(() => Promise.resolve(fakeResponse({ status: 200, body: SAMPLE_SESSION })));

  await act(async () => {
    render(
      <MemoryRouter>
        <SessionProvider>
          <SessionExpiryWarning />
        </SessionProvider>
      </MemoryRouter>
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  act(() => {
    setSessionExpiryFromHeaders({ get: (name) => (name === 'X-Session-Expires-In' ? '60' : 'true') });
  });

  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent(/sessions end after 8 hours/i);
  expect(screen.getByRole('button', { name: 'OK' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Stay signed in' })).not.toBeInTheDocument();
});

test('clicking OK on the max-reached dialog keeps it dismissed for the rest of the session', async () => {
  jest.useFakeTimers('modern');
  global.fetch = jest.fn(() => Promise.resolve(fakeResponse({ status: 200, body: SAMPLE_SESSION })));

  await act(async () => {
    render(
      <MemoryRouter>
        <SessionProvider>
          <SessionExpiryWarning />
        </SessionProvider>
      </MemoryRouter>
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  act(() => {
    setSessionExpiryFromHeaders({ get: (name) => (name === 'X-Session-Expires-In' ? '60' : 'true') });
  });

  const okBtn = await screen.findByRole('button', { name: 'OK' });
  act(() => {
    okBtn.click();
  });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

  // Still the same session (expiresAt unchanged) — the 15s check must not
  // bring the dialog back up just because it ran again.
  act(() => {
    jest.advanceTimersByTime(30 * 1000);
  });

  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});

test('the dialog\'s Sign out button uses the normal sign-out message, not the expiry message', async () => {
  jest.useFakeTimers('modern');
  global.fetch = jest.fn(() => Promise.resolve(fakeResponse({ status: 200, body: SAMPLE_SESSION })));

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SessionProvider>
          <Routes>
            <Route path="/" element={<SessionExpiryWarning />} />
            <Route path="/login" element={<LocationProbe />} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  act(() => {
    setSessionExpiryFromHeaders({ get: (name) => (name === 'X-Session-Expires-In' ? '90' : 'false') });
  });

  const signOutBtn = await screen.findByRole('button', { name: 'Sign out' });

  await act(async () => {
    signOutBtn.click();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.getByTestId('nav-message')).toHaveTextContent("You've signed out.");
});

test('"Stay signed in" signs out immediately with the expiry message if GET /api/me returns 401', async () => {
  jest.useFakeTimers('modern');
  let callCount = 0;
  global.fetch = jest.fn(() => {
    callCount += 1;
    // Call 1 is SessionProvider's mount-time GET /api/me; every call after
    // that (the "Stay signed in" click, and its follow-on sign-out) finds
    // the session already gone server-side.
    if (callCount === 1) {
      return Promise.resolve(fakeResponse({ status: 200, body: SAMPLE_SESSION }));
    }
    return Promise.resolve(fakeResponse({ status: 401, body: {} }));
  });

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SessionProvider>
          <Routes>
            <Route path="/" element={<SessionExpiryWarning />} />
            <Route path="/login" element={<LocationProbe />} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  act(() => {
    setSessionExpiryFromHeaders({ get: (name) => (name === 'X-Session-Expires-In' ? '90' : 'false') });
  });

  const staySignedInBtn = await screen.findByRole('button', { name: 'Stay signed in' });

  await act(async () => {
    staySignedInBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByTestId('nav-message')).toHaveTextContent('Your session has expired. Please sign in again.');
});
