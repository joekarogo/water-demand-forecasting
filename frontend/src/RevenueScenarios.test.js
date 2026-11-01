import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from './session';
import RevenueScenarios from './RevenueScenarios';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const ANALYST_SESSION = {
  ...SAMPLE_SESSION,
  role: 'commercial_officer',
  role_label: 'Commercial Analyst',
  permissions: ['revenue:view'],
};

function monthResult(month, baselineTotal, scenarioTotal) {
  return {
    month,
    baseline: {
      water: { mid: baselineTotal * 0.6, low: baselineTotal * 0.55, high: baselineTotal * 0.65 },
      wastewater: { mid: baselineTotal * 0.4, low: baselineTotal * 0.35, high: baselineTotal * 0.45 },
      total: { mid: baselineTotal, low: baselineTotal * 0.9, high: baselineTotal * 1.1 },
      volume_m3: 1_000_000,
      not_priced_pct: 2,
    },
    scenarios: [
      {
        name: 'Scenario A',
        water: { mid: scenarioTotal * 0.6, low: scenarioTotal * 0.55, high: scenarioTotal * 0.65 },
        wastewater: { mid: scenarioTotal * 0.4, low: scenarioTotal * 0.35, high: scenarioTotal * 0.45 },
        total: { mid: scenarioTotal, low: scenarioTotal * 0.9, high: scenarioTotal * 1.1 },
        volume_m3: 1_000_000,
        volume_change_m3: 0,
        change_try: scenarioTotal - baselineTotal,
        change_pct: ((scenarioTotal - baselineTotal) / baselineTotal) * 100,
        not_priced_pct: 2,
      },
    ],
  };
}

function sampleTariffsInUse() {
  // Housing and workplace bands deliberately use DIFFERENT m³ ranges here,
  // so tests can confirm the row label shows both when they disagree
  // (rather than assuming they always line up).
  return {
    'KONUT ABONELERİ': [
      { min: 0, max: 4, waterPrice: 16.74, wastewaterPrice: 8.36 },
      { min: 4, max: 10, waterPrice: 32.35, wastewaterPrice: 16.17 },
      { min: 10, max: 20, waterPrice: 41.37, wastewaterPrice: 20.67 },
      { min: 20, max: null, waterPrice: 77.46, wastewaterPrice: 38.72 },
    ],
    'İŞYERİ ABONELERİ': [
      { min: 0, max: 10, waterPrice: 20, wastewaterPrice: 10 },
      { min: 10, max: 30, waterPrice: 30, wastewaterPrice: 15 },
      { min: 30, max: 60, waterPrice: 40, wastewaterPrice: 20 },
      { min: 60, max: null, waterPrice: 50, wastewaterPrice: 25 },
    ],
  };
}

function sampleScenarioResponse({ secondScenario } = {}) {
  const months = [monthResult('2024-09-01', 9_000_000, 9_900_000), monthResult('2024-10-01', 6_000_000, 6_600_000)];
  if (secondScenario) {
    months.forEach((m) => {
      const scenarioBTotal = m.baseline.total.mid * 0.85;
      m.scenarios.push({
        name: 'Scenario B',
        water: { mid: scenarioBTotal * 0.6 },
        wastewater: { mid: scenarioBTotal * 0.4 },
        total: { mid: scenarioBTotal },
        volume_m3: 900_000,
        volume_change_m3: -100_000,
        change_try: scenarioBTotal - m.baseline.total.mid,
        change_pct: ((scenarioBTotal - m.baseline.total.mid) / m.baseline.total.mid) * 100,
        not_priced_pct: 2,
      });
    });
  }
  return {
    forecast_id: 9,
    published_at: '2026-10-25T10:00:00.000Z',
    tariff_version_date: '2024-07-01',
    tariffs_in_use: sampleTariffsInUse(),
    scenarios: [
      { name: 'Scenario A', mode: 'uniform', elasticity: 0, elasticity_scope: 'housing', note: null },
      ...(secondScenario ? [{ name: 'Scenario B', mode: 'uniform', elasticity: -0.35, elasticity_scope: 'housing', note: null }] : []),
    ],
    months,
    twelve_month_totals: {
      baseline: { water: { mid: 90_000_000 }, wastewater: { mid: 60_000_000 }, total: { mid: 150_000_000 }, volume_m3: 12_000_000 },
      scenarios: [
        {
          name: 'Scenario A',
          total: { mid: 165_000_000 },
          change_try: 15_000_000,
          change_pct: 10,
          volume_change_m3: 0,
        },
        ...(secondScenario
          ? [{ name: 'Scenario B', total: { mid: 127_500_000 }, change_try: -22_500_000, change_pct: -15, volume_change_m3: -1_200_000 }]
          : []),
      ],
    },
  };
}

function mockFetch(scenarioBody, { validationErrors } = {}) {
  global.fetch = jest.fn((url, options) => {
    const href = String(url);
    if (href.includes('/api/revenue/scenario')) {
      if (validationErrors) {
        return Promise.resolve(fakeResponse({ status: 400, body: { error: 'Validation failed.', fields: validationErrors } }));
      }
      return Promise.resolve(fakeResponse({ status: 200, body: scenarioBody }));
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
        <RevenueScenarios />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('renders the first forecast month with the baseline-vs-scenario table', async () => {
  mockFetch(sampleScenarioResponse());
  renderPage();

  await waitFor(() => expect(screen.getByLabelText('Month')).toBeInTheDocument(), { timeout: 3000 });
  await waitFor(() => expect(screen.getAllByText(/baseline vs scenarios/).length).toBeGreaterThan(0), { timeout: 3000 });

  const table = screen.getAllByRole('table')[0];
  expect(within(table).getByText('₺9,000,000')).toBeInTheDocument();
  expect(within(table).getByText('₺9,900,000')).toBeInTheDocument();
});

test('changing the month updates the table figures', async () => {
  mockFetch(sampleScenarioResponse());
  renderPage();

  await waitFor(() => expect(screen.getByLabelText('Month')).toBeInTheDocument(), { timeout: 3000 });

  const monthSelect = screen.getByLabelText('Month');
  fireEvent.change(monthSelect, { target: { value: '1' } });

  await waitFor(() => {
    const table = screen.getAllByRole('table')[0];
    expect(within(table).getByText('₺6,000,000')).toBeInTheDocument();
  });
});

test('a 400 validation error from the server is shown inline at the relevant input', async () => {
  mockFetch(null, { validationErrors: { 'scenarios[0].uniform_pct': 'Must be between -50 and 100.' } });
  renderPage();

  await waitFor(() => expect(screen.getByText('Must be between -50 and 100.')).toBeInTheDocument(), { timeout: 3000 });
});

test('the May 2025 İzmir change preset fills in per-step housing and workplace values', async () => {
  mockFetch(sampleScenarioResponse());
  renderPage();

  await waitFor(() => expect(screen.getByText('Per step')).toBeInTheDocument(), { timeout: 3000 });
  fireEvent.click(screen.getByText('Per step'));

  const presetButtons = screen.getAllByText('May 2025 İzmir change');
  fireEvent.click(presetButtons[0]);

  const housingInputs = screen.getAllByLabelText(/housing % change/i);
  expect(housingInputs[0]).toHaveValue(0);
  expect(housingInputs[1]).toHaveValue(15);
  expect(housingInputs[2]).toHaveValue(25);
  expect(housingInputs[3]).toHaveValue(35);
});

test('the preset button is visible and works in uniform mode too, switching to per-step', async () => {
  mockFetch(sampleScenarioResponse());
  renderPage();

  await waitFor(() => expect(screen.getAllByText('May 2025 İzmir change').length).toBeGreaterThan(0), { timeout: 3000 });

  // Still in the default "Uniform %" mode at this point.
  const presetButtons = screen.getAllByText('May 2025 İzmir change');
  fireEvent.click(presetButtons[0]);

  // Clicking the preset switched the panel to Per step and filled it in.
  const housingInputs = screen.getAllByLabelText(/housing % change/i);
  expect(housingInputs[0]).toHaveValue(0);
  expect(housingInputs[3]).toHaveValue(35);
});

test('per-step band rows show the real band ranges from tariffs_in_use, not "Band 1"', async () => {
  mockFetch(sampleScenarioResponse());
  renderPage();

  // Wait for the scenario data (and its tariffs_in_use bands) to actually
  // load before switching modes — the panel itself renders immediately,
  // independent of the fetch, so switching too early would still see the
  // "Band N" fallback used while bands haven't loaded yet.
  await waitFor(() => expect(screen.getByLabelText('Month')).toBeInTheDocument(), { timeout: 3000 });
  fireEvent.click(screen.getByText('Per step'));

  // Housing and workplace ranges differ in the fixture, so the first
  // band's row must show both, not a generic "Band 1" placeholder.
  expect(screen.queryByText('Band 1')).not.toBeInTheDocument();
  expect(screen.getByText('0–4 m³ (housing) · 0–10 m³ (workplace)')).toBeInTheDocument();
  expect(screen.getByText('20+ m³ (housing) · 60+ m³ (workplace)')).toBeInTheDocument();
});

test('the demand-response scope selector explains that housing means the Konut customer group', async () => {
  mockFetch(sampleScenarioResponse());
  renderPage();

  await waitFor(() => expect(screen.getAllByLabelText('Apply demand response to').length).toBeGreaterThan(0), {
    timeout: 3000,
  });
  expect(screen.getAllByText('Housing = the Konut customer group.').length).toBeGreaterThan(0);
});

test('"Remove scenario B" is a normal button inside Scenario B\'s panel header', async () => {
  mockFetch(sampleScenarioResponse({ secondScenario: true }));
  renderPage();

  await waitFor(() => expect(screen.getByText('Compare a second scenario')).toBeInTheDocument(), { timeout: 3000 });
  fireEvent.click(screen.getByText('Compare a second scenario'));

  const removeBtn = await screen.findByRole('button', { name: 'Remove scenario B' });
  // It sits in Scenario B's panel header, alongside its name field.
  const nameInput = screen.getByLabelText('Scenario B name');
  expect(removeBtn.closest('.card-head')).toBe(nameInput.closest('.card-head'));

  fireEvent.click(removeBtn);
  expect(screen.queryByRole('button', { name: 'Remove scenario B' })).not.toBeInTheDocument();
});

test('the summary covers every active scenario, with "more"/"less" wording and the shared ₺ formatter', async () => {
  mockFetch(sampleScenarioResponse({ secondScenario: true }));
  renderPage();

  await waitFor(() => expect(screen.getByText('Compare a second scenario')).toBeInTheDocument(), { timeout: 3000 });
  fireEvent.click(screen.getByText('Compare a second scenario'));

  const summarySection = await screen.findByRole('region', { name: 'Summary' }, { timeout: 3000 });
  const sentences = await waitFor(() => {
    const paragraphs = within(summarySection).getAllByText(/Under/);
    expect(paragraphs.length).toBe(2);
    return paragraphs.map((p) => p.closest('p').textContent);
  });

  // Scenario A: +10% change -> "more". Scenario B: -15% change -> "less".
  expect(sentences[0]).toMatch(/Scenario A/);
  expect(sentences[0]).toMatch(/more than the baseline/);
  expect(sentences[1]).toMatch(/Scenario B/);
  expect(sentences[1]).toMatch(/less than the baseline/);
  // Uses the shared, billions-aware ₺ formatter (millions here, since the
  // fixture's figures are below ₺1,000M).
  expect(sentences[0]).toMatch(/₺\d/);
});
