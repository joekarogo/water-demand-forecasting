import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from './session';
import EmergencyLogin from './EmergencyLogin';
import DemandByDistrict from './DemandByDistrict';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const ADMIN_SESSION = { ...SAMPLE_SESSION, role: 'admin', role_label: 'Admin', permissions: ['user:manage'] };

// Overview is the landing page for every role after signing in — this is
// a regression test for the bug this would otherwise reintroduce: a
// post-login redirect that depends on getFirstPermittedPath (and so
// varies by role, or skips Overview because none of its menu
// permissions match a null-permission item) instead of always going to
// /overview.
test('signing in (emergency login) lands on /overview, regardless of role', async () => {
  let signedIn = false;
  global.fetch = jest.fn((url, options) => {
    const href = String(url);
    if (href.includes('/api/auth/emergency-login')) {
      signedIn = true;
      return Promise.resolve(fakeResponse({ status: 200, body: {} }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(
        signedIn ? fakeResponse({ status: 200, body: ADMIN_SESSION }) : fakeResponse({ status: 401, body: {} })
      );
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });

  render(
    <MemoryRouter initialEntries={['/emergency-login']}>
      <SessionProvider>
        <Routes>
          <Route path="/emergency-login" element={<EmergencyLogin />} />
          <Route path="/overview" element={<div>Overview page probe</div>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>
  );

  await userEvent.type(await screen.findByLabelText('Email'), 'admin@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'correct-password');
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

  await waitFor(() => expect(screen.getByText('Overview page probe')).toBeInTheDocument());
});

// A deep link straight to a specific page must keep working exactly as
// before — Overview only applies right after signing in, never to an
// already-signed-in visit to another URL.
test('a signed-in deep link to another page is not redirected to /overview', async () => {
  const PLANNER_SESSION = {
    ...SAMPLE_SESSION,
    role: 'production_manager',
    role_label: 'Production Planner',
    permissions: ['distribution:view'],
  };
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/distribution')) {
      return Promise.resolve(
        fakeResponse({
          status: 200,
          body: {
            forecast_id: 1,
            published_at: '2026-10-25T10:00:00.000Z',
            data_up_to: '2024-08-01',
            loss_rate: 0.324,
            districts: ['Alpha'],
            subscribers_month: '2024-08-01',
            swing: null,
            months: [
              {
                month: '2026-11-01',
                share_years: [2023, 2022, 2021],
                change_years: [2023, 2022],
                plan_type: null,
                plan_chosen_m3: null,
                districts: [
                  {
                    district: 'Alpha',
                    share_pct: 100,
                    forecast_m3: 1_000_000,
                    lower_m3: 900_000,
                    upper_m3: 1_100_000,
                    allocation_m3: null,
                    share_change_pts: 0,
                    subscribers: 10,
                  },
                ],
              },
            ],
          },
        })
      );
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: PLANNER_SESSION }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });

  render(
    <MemoryRouter initialEntries={['/demand-by-district']}>
      <SessionProvider>
        <Routes>
          <Route path="/demand-by-district" element={<DemandByDistrict />} />
          <Route path="/overview" element={<div>Overview page probe</div>} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>
  );

  await waitFor(() => expect(screen.getByText('Districts covered')).toBeInTheDocument());
  expect(screen.queryByText('Overview page probe')).not.toBeInTheDocument();
});
