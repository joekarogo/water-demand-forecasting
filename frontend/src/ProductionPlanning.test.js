import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
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

function planData(overrides = {}) {
  return {
    forecast_id: 42,
    published_at: '2025-01-01T00:00:00.000Z',
    data_up_to: '2024-12-01',
    latest_stock: null,
    days_of_cover: null,
    loss_rate: 0.12,
    loss_rate_source: 'İZSU 2024 annual report',
    storage_capacity_m3: null,
    storage_capacity_source: null,
    months: buildMonths(),
    ...overrides,
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

function stockRow(overrides = {}) {
  return {
    entry_id: 501,
    recorded_on: '2025-01-05',
    stock_m3: 61_500_000,
    note: null,
    recorded_by: 'Ada Lovelace',
    change_m3: null,
    corrected: false,
    ...overrides,
  };
}

function stockListBody(rows = [], overrides = {}) {
  return { data: rows, window_days: 90, storage_capacity_m3: null, storage_capacity_source: null, ...overrides };
}

// A configurable fetch mock: GET endpoints come from the plain bodies
// passed in; POST /api/production/stock and its /:id/remove sibling are
// routed through handler functions so a test can respond differently
// depending on what was actually sent (e.g. with/without correction_reason)
// instead of relying on call order.
function mockFetch({ plan, stock, onPostStock, onRemove } = {}) {
  global.fetch = jest.fn((url, options = {}) => {
    const href = String(url);
    const method = (options.method || 'GET').toUpperCase();

    if (method === 'POST' && /\/api\/production\/stock\/\d+\/remove$/.test(href)) {
      const body = JSON.parse(options.body);
      return Promise.resolve(
        onRemove ? onRemove(body, href) : fakeResponse({ status: 200, body: { entry_id: 1, state: 'removed' } })
      );
    }
    if (method === 'POST' && href.includes('/api/production/stock')) {
      const body = JSON.parse(options.body);
      return Promise.resolve(onPostStock(body));
    }
    if (href.includes('/api/production/plan/2025-01-01/history')) {
      return Promise.resolve(fakeResponse({ status: 200, body: historyForJanuary() }));
    }
    if (href.includes('/api/production/plan')) {
      return Promise.resolve(fakeResponse({ status: 200, body: plan || planData() }));
    }
    if (href.includes('/api/production/stock')) {
      return Promise.resolve(fakeResponse({ status: 200, body: stock || stockListBody() }));
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

test('the stored-water wording makes clear this is a snapshot, not production', async () => {
  mockFetch({ plan: planData({ latest_stock: { stock_m3: 267_200_000, recorded_on: '2026-10-14' }, storage_capacity_m3: 776_422_000 }) });
  renderPage();

  expect(await screen.findByText('Usable water in storage')).toBeInTheDocument();
  expect(screen.getByText('Record storage reading')).toBeInTheDocument();
  expect(screen.getByLabelText('Reading date')).toBeInTheDocument();
  expect(screen.getByLabelText('Usable water in storage (m³)')).toBeInTheDocument();
  expect(
    screen.getByText('The amount held in dams and reservoirs on this date, not the amount produced.')
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'What is stored water?' })
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Usable raw water held in dams and reservoirs, as recorded by the production team\./)
  ).toBeInTheDocument();

  // 267.2M / 776.422M = 34.4%
  expect(screen.getByText('recorded 14 Oct 2026 · 34.4% of 776.4M m³ capacity')).toBeInTheDocument();
});

test('a 409 reading_exists shows the replace confirmation, and "Replace reading" resends with correction_reason', async () => {
  const onPostStock = (body) => {
    if (body.correction_reason) {
      return fakeResponse({
        status: 200,
        body: {
          entry_id: 777,
          recorded_on: body.recorded_on,
          stock_m3: body.stock_m3,
          note: null,
          recorded_by: 'Test User',
          created_at: '2025-02-01T10:00:00.000Z',
          corrected: true,
        },
      });
    }
    return fakeResponse({
      status: 409,
      body: {
        code: 'reading_exists',
        error: 'There is already a reading for this date.',
        existing: { stock_m3: 60_000_000, recorded_on: body.recorded_on, recorded_by: 'Ada Lovelace' },
      },
    });
  };
  mockFetch({ onPostStock });
  renderPage();

  const dateInput = await screen.findByLabelText('Reading date');
  fireEvent.change(dateInput, { target: { value: '2025-02-01' } });
  fireEvent.change(screen.getByLabelText('Usable water in storage (m³)'), { target: { value: '61500000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(
    await screen.findByText('There is already a reading of 60.0M m³ for 1 Feb 2025, recorded by Ada Lovelace. Replace it?')
  ).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Reason for the correction'), {
    target: { value: 'First entry had a typo in the amount.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Replace reading' }));

  await waitFor(() => expect(screen.queryByText('Replace this reading?')).not.toBeInTheDocument());
  expect(await screen.findByText('Storage reading for 1 Feb 2025 corrected')).toBeInTheDocument();

  const lastCall = global.fetch.mock.calls.find(
    ([, options]) => options && options.method === 'POST' && JSON.parse(options.body).correction_reason
  );
  expect(lastCall).toBeTruthy();
  const sentBody = JSON.parse(lastCall[1].body);
  expect(sentBody.correction_reason).toBe('First entry had a typo in the amount.');
  expect(sentBody.recorded_on).toBe('2025-02-01');
});

test('a 409 large_change shows the confirmation, and "Yes, save it" resends with confirm_large_change: true', async () => {
  const onPostStock = (body) => {
    if (body.confirm_large_change) {
      return fakeResponse({
        status: 200,
        body: {
          entry_id: 888,
          recorded_on: body.recorded_on,
          stock_m3: body.stock_m3,
          note: null,
          recorded_by: 'Test User',
          created_at: '2025-03-01T10:00:00.000Z',
          corrected: false,
        },
      });
    }
    return fakeResponse({
      status: 409,
      body: {
        code: 'large_change',
        error: 'This is very different from the previous reading.',
        previous: { recorded_on: '2025-02-01', stock_m3: 42_000_000 },
        change_pct: 42.857142857142854,
      },
    });
  };
  mockFetch({ onPostStock });
  renderPage();

  fireEvent.change(await screen.findByLabelText('Reading date'), { target: { value: '2025-03-01' } });
  fireEvent.change(screen.getByLabelText('Usable water in storage (m³)'), { target: { value: '60000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(
    await screen.findByText('This is 42.9% higher than the last reading (42.0M m³ on 1 Feb 2025). Is the amount correct?')
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Yes, save it' }));

  await waitFor(() => expect(screen.queryByText('Check this amount')).not.toBeInTheDocument());
  expect(await screen.findByText('Storage reading of 60.0M m³ saved for 1 Mar 2025')).toBeInTheDocument();

  const confirmedCall = global.fetch.mock.calls.find(
    ([, options]) => options && options.method === 'POST' && JSON.parse(options.body).confirm_large_change
  );
  expect(confirmedCall).toBeTruthy();
});

test('"Check again" closes the large-change confirmation and returns focus to the amount field', async () => {
  const onPostStock = () =>
    fakeResponse({
      status: 409,
      body: {
        code: 'large_change',
        error: 'This is very different from the previous reading.',
        previous: { recorded_on: '2025-02-01', stock_m3: 42_000_000 },
        change_pct: -42,
      },
    });
  mockFetch({ onPostStock });
  renderPage();

  fireEvent.change(await screen.findByLabelText('Reading date'), { target: { value: '2025-03-01' } });
  fireEvent.change(screen.getByLabelText('Usable water in storage (m³)'), { target: { value: '24000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));

  await screen.findByText(/Is the amount correct\?/);
  fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

  expect(screen.queryByText(/Is the amount correct\?/)).not.toBeInTheDocument();
  expect(screen.getByLabelText('Usable water in storage (m³)')).toHaveFocus();
});

test('Remove posts to /api/production/stock/<entry_id>/remove with the reason and refreshes', async () => {
  const row = stockRow({ entry_id: 501, recorded_on: '2025-01-05', stock_m3: 61_500_000 });
  const onRemove = (body) => {
    expect(body.reason).toBe('Entered for the wrong reservoir.');
    return fakeResponse({ status: 200, body: { entry_id: 501, recorded_on: '2025-01-05', state: 'removed' } });
  };
  mockFetch({ stock: stockListBody([row]), onRemove });
  renderPage();

  const removeBtn = await screen.findByRole('button', { name: /Remove the 5 Jan 2025 storage reading/ });
  fireEvent.click(removeBtn);

  const dialog = await screen.findByRole('dialog', { name: 'Remove this reading?' });
  expect(
    within(dialog).getByText(
      'Remove the reading of 61.5M m³ for 5 Jan 2025? It will be kept in the activity log but no longer used for days of supply.'
    )
  ).toBeInTheDocument();

  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'Entered for the wrong reservoir.' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove reading' }));

  await waitFor(() => expect(screen.queryByText('Remove this reading?')).not.toBeInTheDocument());
  expect(await screen.findByText('Storage reading removed')).toBeInTheDocument();

  const removeCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/api/production/stock/501/remove'));
  expect(removeCall).toBeTruthy();
});

test('the correction and remove reason fields enforce 5-300 characters client-side', async () => {
  const row = stockRow({ entry_id: 501, recorded_on: '2025-01-05', stock_m3: 61_500_000 });
  mockFetch({ stock: stockListBody([row]) });
  renderPage();

  const removeBtn = await screen.findByRole('button', { name: /Remove the 5 Jan 2025 storage reading/ });
  fireEvent.click(removeBtn);

  const dialog = await screen.findByRole('dialog', { name: 'Remove this reading?' });
  fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'ab' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove reading' }));

  expect(await within(dialog).findByText('Enter a reason (5-300 characters).')).toBeInTheDocument();
  // Too short to submit — no network call should have been made for it.
  const removeCalls = global.fetch.mock.calls.filter(([url]) => String(url).includes('/remove'));
  expect(removeCalls.length).toBe(0);
});

test('Escape closes an open confirmation and returns focus to the row that opened it', async () => {
  const row = stockRow({ entry_id: 501, recorded_on: '2025-01-05', stock_m3: 61_500_000 });
  mockFetch({ stock: stockListBody([row]) });
  renderPage();

  const removeBtn = await screen.findByRole('button', { name: /Remove the 5 Jan 2025 storage reading/ });
  fireEvent.click(removeBtn);
  await screen.findByRole('dialog', { name: 'Remove this reading?' });

  fireEvent.keyDown(document, { key: 'Escape' });

  expect(screen.queryByText('Remove this reading?')).not.toBeInTheDocument();
  expect(removeBtn).toHaveFocus();
});
