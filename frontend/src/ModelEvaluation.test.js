import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SessionProvider } from './session';
import ModelEvaluation from './ModelEvaluation';
import { fakeResponse, SAMPLE_SESSION } from './testFetchMock';

const PLANNER_SESSION = {
  ...SAMPLE_SESSION,
  role: 'production_manager',
  role_label: 'Production Planner',
  permissions: ['forecast:view', 'plan:view'],
};

const SARIMA_LABEL = 'SARIMA(1, 0, 0)x(0, 1, 1, 12)';

// A conformal-style {by_horizon, average} block, shaped exactly like
// backend/modelEvaluation.js's loadConformal/loadEnsembleConformal output.
function conformalEntry(atOrBelowUpper1, atOrBelowUpper12, avgTwoSided, avgUpper, avgWidth) {
  return {
    by_horizon: {
      1: { two_sided_coverage_pct: 90, at_or_below_upper_coverage_pct: atOrBelowUpper1, mean_width_pct: 20, n: 15 },
      12: { two_sided_coverage_pct: 70, at_or_below_upper_coverage_pct: atOrBelowUpper12, mean_width_pct: 16, n: 15 },
    },
    average: { two_sided_coverage_pct: avgTwoSided, at_or_below_upper_coverage_pct: avgUpper, mean_width_pct: avgWidth },
  };
}

function fullEvaluationBody() {
  return {
    published_model_name: 'Ensemble (Prophet + SARIMA, 50/50)',
    sections: {
      test_set_metrics: {
        models: {
          'Prophet (defaults)': { mae: 1_027_291, rmse: 1_308_929, mape: 4.86 },
          [SARIMA_LABEL]: { mae: 1_127_920, rmse: 1_406_426, mape: 5.25 },
          'Seasonal-naive': { mae: 1_177_106, rmse: 1_483_668, mape: 5.47 },
          'Last-year x growth': { mae: 1_343_804, rmse: 1_642_604, mape: 6.23 },
        },
        chosen_sarima_order: [1, 0, 0],
        chosen_sarima_seasonal_order: [0, 1, 1, 12],
      },
      rolling_origin: {
        models: {
          'Prophet (defaults)': {
            1: { mean_mape: 5.66, min_abs_pct_error: 0.8, median_abs_pct_error: 4.8, max_abs_pct_error: 17.4, n_origins: 15 },
            12: { mean_mape: 4.62, min_abs_pct_error: 0.5, median_abs_pct_error: 4.0, max_abs_pct_error: 13.0, n_origins: 15 },
          },
        },
        n_origins_total: 15,
        coverage_caveat: 'Overlapping origins are not independent observations.',
      },
      diebold_mariano: {
        pairs: [
          { model_a: 'Prophet (defaults)', model_b: SARIMA_LABEL, horizon: 1, n: 15, dm_statistic: 0.84, p_value: 0.41 },
          { model_a: SARIMA_LABEL, model_b: 'Seasonal-naive', horizon: 12, n: 15, dm_statistic: 'not computable', p_value: 'not computable' },
        ],
        caveats: ['With n = 15 origins, the h = 12 test uses 11 autocovariance lags; treat h = 12 results as indicative only.'],
      },
      conformal: {
        prophet_raw: conformalEntry(100, 80, 89.4, 96.7, 18.0),
        prophet_conformal: conformalEntry(100, 80, 89.4, 96.7, 18.0),
        sarima: conformalEntry(93.3, 86.7, 87.8, 95.0, 19.7),
      },
      ensemble_conformal: {
        ensemble_conformal: conformalEntry(93.3, 80.0, 86.1, 94.4, 15.9),
        run_timestamp: '2026-11-11T07:35:14.003150+00:00',
      },
      ensemble: {
        sarima_label: SARIMA_LABEL,
        test_metrics: {
          'Ensemble (50/50)': { mae: 892_175, rmse: 1_190_331, mape: 4.1 },
          'Prophet (defaults)': { mae: 1_027_291, rmse: 1_308_929, mape: 4.86 },
          [SARIMA_LABEL]: { mae: 1_127_920, rmse: 1_406_426, mape: 5.25 },
        },
        rolling_mape_by_horizon: {
          'Ensemble (50/50)': { 1: 4.68, 2: 4.34, 3: 4.11, 4: 3.93, 5: 3.84, 6: 3.97, 7: 4.04, 8: 4.44, 9: 4.53, 10: 4.71, 11: 4.66, 12: 4.47 },
          'Prophet (defaults)': { 1: 5.66, 2: 5.5, 3: 5.69, 4: 5.34, 5: 5.14, 6: 5.01, 7: 4.69, 8: 5.03, 9: 4.71, 10: 4.79, 11: 4.81, 12: 4.62 },
          [SARIMA_LABEL]: { 1: 4.72, 2: 4.43, 3: 4.18, 4: 4.15, 5: 4.39, 6: 4.65, 7: 4.53, 8: 5.21, 9: 5.67, 10: 6.12, 11: 6.05, 12: 5.91 },
          'Seasonal-naive': { 1: 4.78, 2: 4.56, 3: 4.34, 4: 4.28, 5: 4.47, 6: 4.72, 7: 4.53, 8: 5.27, 9: 5.74, 10: 6.26, 11: 6.11, 12: 5.91 },
          'Last-year x growth': { 1: 4.99, 2: 4.44, 3: 4.28, 4: 4.22, 5: 4.47, 6: 4.76, 7: 4.29, 8: 4.83, 9: 5.42, 10: 5.73, 11: 5.69, 12: 5.33 },
        },
        dm_vs_prophet: {
          1: { n: 15, dm_statistic: -1.62, p_value: 0.13 },
          6: { n: 15, dm_statistic: -1.51, p_value: 0.15 },
          12: { n: 15, dm_statistic: -1.11, p_value: 0.29 },
        },
        dm_vs_sarima: {
          1: { n: 15, dm_statistic: -0.01, p_value: 0.99 },
          6: { n: 15, dm_statistic: 0.14, p_value: 0.89 },
          12: { n: 15, dm_statistic: -0.74, p_value: 0.47 },
        },
        run_timestamp: '2026-11-10T22:36:21.990574+00:00',
      },
      other_inputs: {
        items: [
          { name: 'Weather (typical for the month)', test_mape: 4.78, h12_mape: 4.69, adopted: false },
          { name: 'Bayram holiday days', test_mape: 5.04, h12_mape: 4.94, adopted: false },
        ],
      },
      protocol: {
        protocol_date: '26 October 2026 (01:58 EAT)',
        train_period: '2014-01 to 2022-06 (102 months)',
        test_period: '2022-07 to 2024-08 (26 months)',
        outlier_rule: 'Five outlier months were interpolated using a centered 13-month rolling median.',
        models_compared: ['Prophet (defaults)', SARIMA_LABEL],
        chosen_sarima_order: [1, 0, 0],
        chosen_sarima_seasonal_order: [0, 1, 1, 12],
      },
    },
    unavailable: [],
    provenance: [{ section: 'ensemble', file: 'ml/results/ensemble_experiment.json' }],
  };
}

function mockFetch(body) {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/model-evaluation')) {
      return Promise.resolve(fakeResponse({ status: 200, body }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: PLANNER_SESSION }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });
}

function renderPage(initialPath = '/model-evaluation') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SessionProvider>
        <ModelEvaluation />
      </SessionProvider>
    </MemoryRouter>
  );
}

// MemoryRouter keeps its own in-memory location, separate from jsdom's
// window.location — so to see the hash the component navigated to, this
// probe reads it via useLocation() and puts it in the DOM instead.
function LocationHashProbe() {
  const location = useLocation();
  return <div data-testid="hash-probe">{location.hash}</div>;
}

function renderPageWithHashProbe(initialPath = '/model-evaluation') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SessionProvider>
        <ModelEvaluation />
        <LocationHashProbe />
      </SessionProvider>
    </MemoryRouter>
  );
}

test('the "Performance summary" card shows exactly 3 plain-language bullets, with the comparison clause included when the ensemble actually is better', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();

  const summary = await screen.findByText('Performance summary');
  const items = summary.closest('section').querySelectorAll('li');
  expect(items.length).toBe(3);

  const text = summary.closest('section').textContent;
  expect(text).toMatch(/off by 4\.1% on average — better than either model alone and better than simply repeating last year/);
  expect(text).toMatch(/roughly 4–5% average error at every distance/);
  expect(text).toMatch(/held in about 9 in 10 months \(8 in 10 when looking 12 months ahead\)/);
});

test('the comparison clause is omitted when the ensemble is not actually better than every baseline', async () => {
  const body = fullEvaluationBody();
  // Make Seasonal-naive's test MAPE beat the ensemble's, so "better than
  // simply repeating last year" would be false if asserted blindly.
  body.sections.test_set_metrics.models['Seasonal-naive'].mape = 3.0;
  mockFetch(body);
  renderPage();

  const summary = await screen.findByText('Performance summary');
  const text = summary.closest('section').textContent;
  expect(text).toMatch(/off by 4\.1% on average\./);
  expect(text).not.toMatch(/better than either model alone/);
});

test('"In short" does not appear anywhere on the page', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();

  await waitFor(() => expect(screen.getByText('Performance summary')).toBeInTheDocument());
  expect(screen.queryByText('In short')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/In short/);
});

test('no file path is rendered anywhere on the page', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();

  await waitFor(() => expect(screen.getByText('Performance summary')).toBeInTheDocument());
  fireEvent.click(await screen.findByText('Technical details'));
  await waitFor(() => expect(screen.getByText('Evaluation protocol')).toBeInTheDocument());

  expect(document.body.textContent).not.toMatch(/ml[\\/]results/);
  expect(document.body.textContent).not.toMatch(/\.json/);
  expect(document.body.textContent).not.toMatch(/\.csv/);
  expect(screen.queryByText(/Results read from/)).not.toBeInTheDocument();
});

test('"How the methods compared" lists the 5 models sorted best-first, with plain display names only', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();

  await waitFor(() => expect(screen.getByText('How the methods compared')).toBeInTheDocument());
  const card = screen.getByText('How the methods compared').closest('section');
  const items = within(card).getAllByRole('listitem');
  const names = items.map((li) => li.textContent);

  expect(names[0]).toMatch(/^Ensemble \(Prophet \+ SARIMA\) — published: 4\.1%/);
  expect(names[1]).toMatch(/^Prophet: 4\.9%/);
  expect(names[2]).toMatch(/^SARIMA: 5\.3%/);
  expect(names[3]).toMatch(/^Same as last year: 5\.5%/);
  expect(names[4]).toMatch(/^Last year × growth: 6\.2%/);

  // No raw model-name jargon anywhere in this card.
  expect(card.textContent).not.toMatch(/Ensemble \(50\/50\)/);
  expect(card.textContent).not.toMatch(/Prophet \(defaults\)/);
  expect(card.textContent).not.toMatch(SARIMA_LABEL);
  expect(card.textContent).not.toMatch(/Seasonal-naive/);
});

test('"Technical details" starts collapsed, and opening it updates the URL hash', async () => {
  mockFetch(fullEvaluationBody());
  renderPageWithHashProbe();

  await waitFor(() => expect(screen.getByText('Performance summary')).toBeInTheDocument());

  const summary = screen.getByText('Technical details');
  const details = summary.closest('details');
  expect(details.open).toBe(false);
  expect(screen.getByTestId('hash-probe').textContent).toBe('');

  fireEvent.click(summary);
  await waitFor(() => expect(details.open).toBe(true));
  await waitFor(() => expect(screen.getByTestId('hash-probe').textContent).toBe('#technical-details'));

  fireEvent.click(summary);
  await waitFor(() => expect(details.open).toBe(false));
  await waitFor(() => expect(screen.getByTestId('hash-probe').textContent).toBe(''));
});

test('a link ending in #technical-details lands on the page with it already open', async () => {
  mockFetch(fullEvaluationBody());
  renderPage('/model-evaluation#technical-details');

  await waitFor(() => expect(screen.getByText('Performance summary')).toBeInTheDocument());
  const details = screen.getByText('Technical details').closest('details');
  expect(details.open).toBe(true);
});

test('"Error by months ahead" shows h1-h12 for exactly 5 models, dropping Prophet (CV-tuned)', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();
  fireEvent.click(await screen.findByText('Technical details'));

  const title = await screen.findByText('Error by months ahead');
  const card = title.closest('section');
  expect(within(card).getAllByText('Ensemble (Prophet + SARIMA) — published').length).toBeGreaterThan(0);
  expect(within(card).getAllByText('Prophet').length).toBeGreaterThan(0);
  expect(within(card).getAllByText('SARIMA').length).toBeGreaterThan(0);
  expect(within(card).getAllByText('Same as last year').length).toBeGreaterThan(0);
  expect(within(card).getAllByText('Last year × growth').length).toBeGreaterThan(0);
  expect(card.textContent).not.toMatch(/CV-tuned/);
  expect(within(card).getAllByText('12 mo').length).toBeGreaterThan(0);
  expect(card.textContent).toMatch(/15 forecast start points, Jun 2022 – Aug 2023/);
});

test('"Likely range reliability" shows all 4 calibrated/raw ranges', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();
  fireEvent.click(await screen.findByText('Technical details'));

  const title = await screen.findByText('Likely range reliability');
  const card = title.closest('section');
  expect(within(card).getByText('Ensemble (calibrated)')).toBeInTheDocument();
  expect(within(card).getByText('Prophet (calibrated)')).toBeInTheDocument();
  expect(within(card).getByText('Prophet (original range)')).toBeInTheDocument();
  expect(within(card).getByText('SARIMA')).toBeInTheDocument();
});

test('"Are the differences significant?" merges the Protocol 1 pairs with the new Ensemble pairs, and shows "—" for not-computable values', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();
  fireEvent.click(await screen.findByText('Technical details'));

  const title = await screen.findByText('Are the differences significant?');
  const card = title.closest('section');
  // One Ensemble-vs-Prophet row and one Ensemble-vs-SARIMA row, per horizon.
  expect(within(card).getAllByText('Ensemble (Prophet + SARIMA) — published').length).toBe(6);
  expect(card.textContent).toMatch(/not statistically proven/);
  // The SARIMA vs Seasonal-naive h=12 pair is "not computable" in the fixture.
  const rows = within(card).getAllByRole('row');
  const notComputableRow = rows.find((r) => r.textContent.includes('Same as last year') && r.textContent.includes('12 mo'));
  expect(notComputableRow.textContent).toMatch(/—/);

  // The published model's own rows (Ensemble vs Prophet, then Ensemble vs
  // SARIMA) come first, ahead of the pre-existing Protocol 1 pairs.
  const bodyRows = rows.slice(1); // drop the header row
  const ensembleRowCount = bodyRows.filter((r) => r.textContent.includes('Ensemble (Prophet + SARIMA) — published')).length;
  for (let i = 0; i < ensembleRowCount; i++) {
    expect(bodyRows[i].textContent).toMatch(/Ensemble \(Prophet \+ SARIMA\) — published/);
  }
  expect(bodyRows[ensembleRowCount].textContent).not.toMatch(/Ensemble \(Prophet \+ SARIMA\) — published/);
});

test('"Other inputs evaluated" shows exactly the weather and Bayram variants, never the "best case" variant', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();
  fireEvent.click(await screen.findByText('Technical details'));

  const title = await screen.findByText('Other inputs evaluated');
  const card = title.closest('section');
  expect(within(card).getByText('Weather (typical for the month)')).toBeInTheDocument();
  expect(within(card).getByText('Bayram holiday days')).toBeInTheDocument();
  expect(within(card).getAllByText('Not adopted').length).toBe(2);
  expect(card.textContent).not.toMatch(/best case/i);
});

test('"Evaluation protocol" states the train/test periods and that the test set was never used for tuning', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();
  fireEvent.click(await screen.findByText('Technical details'));

  await waitFor(() => expect(screen.getByText('Evaluation protocol')).toBeInTheDocument());
  expect(screen.getByText(/2014-01 to 2022-06/)).toBeInTheDocument();
  expect(screen.getByText(/never used to choose or tune any model/i)).toBeInTheDocument();
  expect(
    screen.getByText(/A second round of experiments \(calibrated ranges, weather, holiday days and the ensemble\) was/)
  ).toBeInTheDocument();
  expect(screen.getByText(/fixed in writing on 8 November 2026, before any of them were run/)).toBeInTheDocument();
});

test('the footer shows the published model name, the later of the two run_timestamps in Nairobi time, and the fixed test period', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();

  // ensemble.run_timestamp = 2026-11-10T22:36:21Z (01:36 EAT on the 11th);
  // ensemble_conformal.run_timestamp = 2026-11-11T07:35:14Z (10:35 EAT on
  // the 11th) — the later of the two, both landing on "11 Nov 2026".
  await waitFor(() =>
    expect(screen.getByText('Model: Ensemble (Prophet + SARIMA, 50/50) · Last evaluated: 11 Nov 2026 · Test period: Jul 2022 – Aug 2024 (26 months)')).toBeInTheDocument()
  );
});

test('the footer shows "not available" when no model has ever been published', async () => {
  const body = fullEvaluationBody();
  body.published_model_name = null;
  mockFetch(body);
  renderPage();

  await waitFor(() => expect(screen.getByText(/Model: not available/)).toBeInTheDocument());
});

test('each new section renders a calm "not available" notice, not an error, when its underlying file is missing', async () => {
  const body = fullEvaluationBody();
  delete body.sections.conformal;
  delete body.sections.ensemble_conformal;
  delete body.sections.other_inputs;
  mockFetch(body);
  renderPage();
  fireEvent.click(await screen.findByText('Technical details'));

  await waitFor(() => expect(screen.getByText('Likely range reliability')).toBeInTheDocument());
  expect(screen.getAllByText(/isn't available from the stored evaluation files/i).length).toBe(2);
  expect(screen.queryByText("The model evaluation couldn't be loaded.")).not.toBeInTheDocument();
});

test('the "Performance summary" card is omitted when none of its underlying data is available', async () => {
  mockFetch({ published_model_name: null, sections: {}, unavailable: [], provenance: [] });
  renderPage();

  await waitFor(() => expect(screen.getByText('No evaluation results are available')).toBeInTheDocument());
  expect(screen.queryByText('Performance summary')).not.toBeInTheDocument();
});

test('an error response shows a retry button', async () => {
  global.fetch = jest.fn((url) => {
    const href = String(url);
    if (href.includes('/api/model-evaluation')) {
      return Promise.resolve(fakeResponse({ status: 500, body: { error: 'oops', reference: 'ERR-1' } }));
    }
    if (href.includes('/api/me')) {
      return Promise.resolve(fakeResponse({ status: 200, body: PLANNER_SESSION }));
    }
    return Promise.resolve(fakeResponse({ status: 404, body: {} }));
  });
  renderPage();

  await waitFor(() => expect(screen.getByText("The model evaluation couldn't be loaded.")).toBeInTheDocument());
  expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
});
