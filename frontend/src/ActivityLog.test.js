import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import ActivityLog from './ActivityLog';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const ADMIN_SESSION = {
  ...SAMPLE_SESSION,
  role: 'admin',
  role_label: 'Admin',
  permissions: ['audit:view_all', 'user:manage'],
};
const PLANNER_SESSION = {
  ...SAMPLE_SESSION,
  role: 'production_manager',
  role_label: 'Production Planner',
  permissions: ['audit:view_own'],
};

function sampleResult(scope, overrides = {}) {
  return {
    rows: [
      {
        occurred_at: '2026-10-25T10:00:00.000Z',
        actor: 'Ada Lovelace',
        action: 'login.success',
        label: 'Signed in',
        category: 'sign_in',
        entity: 'users',
        entity_id: '1',
        details: null,
        ...(scope === 'all' ? { ip_address: '203.0.113.10' } : {}),
      },
    ],
    total: 1,
    page: 1,
    page_size: 50,
    scope,
    ...overrides,
  };
}

function mockFetch({ session, activityLogResult, usersBody = { users: [] }, exportCsv = 'Time,Who,What\r\n' }) {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/activity-log/export')) {
      return Promise.resolve(fakeResponse({ status: 200, text: exportCsv }));
    }
    if (href.includes('/api/activity-log')) {
      return Promise.resolve(fakeResponse({ status: 200, body: activityLogResult }));
    }
    if (href.includes('/api/users')) {
      return Promise.resolve(fakeResponse({ status: 200, body: usersBody }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: session }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/activity-log']}>
      <SessionProvider>
        <ActivityLog />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('an Admin (audit:view_all) session sees the IP address column and subtitle', async () => {
  mockFetch({ session: ADMIN_SESSION, activityLogResult: sampleResult('all') });
  renderPage();

  await waitFor(() => expect(screen.getByText('Signed in')).toBeInTheDocument());
  expect(screen.getByText('Everything that happened in the system')).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'IP address' })).toBeInTheDocument();
  expect(screen.getByText('203.0.113.10')).toBeInTheDocument();
});

test('a Production Planner (audit:view_own) session never sees an IP address column', async () => {
  mockFetch({ session: PLANNER_SESSION, activityLogResult: sampleResult('own') });
  renderPage();

  await waitFor(() => expect(screen.getByText('Signed in')).toBeInTheDocument());
  expect(screen.getByText('Your own activity')).toBeInTheDocument();
  expect(screen.queryByRole('columnheader', { name: 'IP address' })).not.toBeInTheDocument();
});

test('changing the category filter re-fetches with the new category in the query string', async () => {
  mockFetch({ session: ADMIN_SESSION, activityLogResult: sampleResult('all') });
  renderPage();

  await waitFor(() => expect(screen.getByText('Signed in')).toBeInTheDocument());

  fireEvent.change(screen.getByLabelText('Category'), { target: { value: 'failed_sign_in' } });

  await waitFor(() => {
    const calledUrls = global.fetch.mock.calls.map((c) => String(c[0]));
    expect(calledUrls.some((u) => u.includes('/api/activity-log?') && u.includes('category=failed_sign_in'))).toBe(
      true
    );
  });
});

test('no matching rows shows a calm empty state, not an error', async () => {
  mockFetch({ session: ADMIN_SESSION, activityLogResult: sampleResult('all', { rows: [], total: 0 }) });
  renderPage();

  await waitFor(() => expect(screen.getByText('No activity matches these filters.')).toBeInTheDocument());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

// A plain <a href="/api/activity-log/export"> doesn't work through the CRA
// dev-server proxy (it skips requests that look like a page navigation),
// so Export CSV must fetch via apiFetch and save the response itself —
// never a bare link straight to the API.
test('Export CSV fetches the CSV via apiFetch and saves it as a file, not a bare link to the API', async () => {
  mockFetch({ session: ADMIN_SESSION, activityLogResult: sampleResult('all'), exportCsv: 'Time,Who,What\r\n2026-10-25T10:00:00.000Z,Ada,Signed in' });
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = jest.fn();
  const clickSpy = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

  renderPage();
  await waitFor(() => expect(screen.getByText('Signed in')).toBeInTheDocument());

  const exportButton = screen.getByRole('button', { name: /Export CSV/i });
  expect(exportButton.tagName).toBe('BUTTON'); // not an <a> pointed straight at the API URL
  fireEvent.click(exportButton);

  await waitFor(() => expect(clickSpy).toHaveBeenCalled());
  const calledUrls = global.fetch.mock.calls.map((c) => String(c[0]));
  expect(calledUrls.some((u) => u.includes('/api/activity-log/export'))).toBe(true);
  expect(global.URL.createObjectURL).toHaveBeenCalled();
  expect(global.URL.createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);

  clickSpy.mockRestore();
});
