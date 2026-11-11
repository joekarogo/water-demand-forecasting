import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import ProductionPlanning from './ProductionPlanning';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const PLANNER_SESSION = {
  ...SAMPLE_SESSION,
  role: 'production_manager',
  role_label: 'Production Planner',
  permissions: ['plan:view'],
};

const SAVED_NOTE = 'Scheduled maintenance at the Çamlı plant in week 2.';

function buildMonths() {
  const months = [];
  for (let i = 0; i < 12; i++) {
    const monthNum = String(i + 1).padStart(2, '0');
    months.push({
      month: `2025-${monthNum}-01`,
      forecast_m3: 20_000_000 + i * 100_000,
      normal_m3: 20_000_000 + i * 100_000,
      safe_m3: 23_000_000 + i * 100_000,
      lower_m3: 19_000_000 + i * 100_000,
      upper_m3: 23_000_000 + i * 100_000,
      plan: null,
    });
  }
  // January already has a saved SAFE plan with a note and no reason
  // (reason only ever applies to custom plans) — this is the fixture for
  // both the "Plan history" note-display bug and the note-prefill bug.
  months[0].plan = {
    plan_type: 'safe',
    chosen_m3: months[0].safe_m3,
    reason: null,
    note: SAVED_NOTE,
    created_at: '2025-01-01T10:00:00.000Z',
    created_by: 'Ada Lovelace',
    version: 1,
  };
  return months;
}

function planData() {
  return {
    forecast_id: 42,
    published_at: '2025-01-01T00:00:00.000Z',
    data_up_to: '2024-12-01',
    latest_stock: null,
    days_of_cover: null,
    loss_rate: 0.12,
    loss_rate_source: 'İZSU 2024 annual report',
    months: buildMonths(),
  };
}

function historyForJanuary() {
  return {
    history: [
      {
        plan_id: 101,
        plan_type: 'safe',
        chosen_m3: 23_000_000,
        reason: null,
        note: SAVED_NOTE,
        created_at: '2025-01-01T10:00:00.000Z',
        created_by: 'Ada Lovelace',
      },
    ],
  };
}

function mockFetch() {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/production/plan/2025-01-01/history')) {
      return Promise.resolve(fakeResponse({ status: 200, body: historyForJanuary() }));
    }
    if (href.includes('/api/production/plan')) {
      return Promise.resolve(fakeResponse({ status: 200, body: planData() }));
    }
    if (href.includes('/api/production/stock')) {
      return Promise.resolve(fakeResponse({ status: 200, body: { data: [], window_days: 90 } }));
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
        <ProductionPlanning />
      </SessionProvider>
    </MemoryRouter>
  );
}

async function openJanuaryPanel() {
  const bar = await screen.findByRole('button', { name: /Jan 2025: forecast/ });
  fireEvent.click(bar);
  await screen.findByText('Plan for Jan 2025');
}

test('plan history shows "Note: …" for a non-custom (safe) plan, and never "Reason: —"', async () => {
  mockFetch();
  renderPage();
  await openJanuaryPanel();

  expect(await screen.findByText(`Note: ${SAVED_NOTE}`)).toBeInTheDocument();
  expect(screen.queryByText('Reason: —')).not.toBeInTheDocument();
  expect(screen.queryByText(/^Reason:/)).not.toBeInTheDocument();
});

test('reopening a saved safe plan prefills its note into the Note field', async () => {
  mockFetch();
  renderPage();
  await openJanuaryPanel();

  const noteField = screen.getByLabelText('Note (optional)');
  expect(noteField.value).toBe(SAVED_NOTE);
});
