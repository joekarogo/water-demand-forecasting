import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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

function fullEvaluationBody() {
  return {
    sections: {
      test_set_metrics: {
        models: {
          'Prophet (defaults)': { mae: 1_027_291, rmse: 1_308_929, mape: 4.86 },
          'SARIMA(1, 0, 0)x(0, 1, 1, 12)': { mae: 1_127_920, rmse: 1_406_426, mape: 5.25 },
        },
        chosen_sarima_order: [1, 0, 0],
        chosen_sarima_seasonal_order: [0, 1, 1, 12],
      },
      rolling_origin: {
        models: {
          'Prophet (defaults)': {
            1: { mean_mape: 5.66, min_abs_pct_error: 0.8, median_abs_pct_error: 4.8, max_abs_pct_error: 17.4, n_origins: 15 },
            3: { mean_mape: 5.69, min_abs_pct_error: 1.0, median_abs_pct_error: 5.0, max_abs_pct_error: 15.0, n_origins: 15 },
            6: { mean_mape: 5.01, min_abs_pct_error: 0.9, median_abs_pct_error: 4.5, max_abs_pct_error: 14.0, n_origins: 15 },
            12: { mean_mape: 4.62, min_abs_pct_error: 0.5, median_abs_pct_error: 4.0, max_abs_pct_error: 13.0, n_origins: 15 },
          },
        },
        n_origins_total: 15,
        coverage_caveat: 'Overlapping origins are not independent observations.',
      },
      diebold_mariano: {
        pairs: [
          { model_a: 'Prophet (defaults)', model_b: 'SARIMA(1, 0, 0)x(0, 1, 1, 12)', horizon: 1, n: 15, dm_statistic: 0.84, p_value: 0.41 },
          { model_a: 'Prophet (defaults)', model_b: 'SARIMA(1, 0, 0)x(0, 1, 1, 12)', horizon: 12, n: 15, dm_statistic: -0.16, p_value: 0.88 },
        ],
        caveats: ['With n = 15 origins, the h = 12 test uses 11 autocovariance lags; treat h = 12 results as indicative only.'],
      },
      coverage: {
        two_sided_by_model_horizon: {
          'Prophet (defaults)': { 1: 0.6667, 12: 0.6667 },
          'SARIMA(1, 0, 0)x(0, 1, 1, 12)': { 1: 0.8667, 12: 0.8667 },
        },
        interval_width: 0.8,
        coverage_caveat: 'Forecasts from overlapping origins are not independent observations.',
        one_sided_available: true,
        one_sided_by_model: {
          'Prophet (defaults)': {
            has_interval: true,
            by_horizon: {
              1: { n: 15, two_sided: 0.6667, at_or_below_upper: 0.9333, at_or_above_lower: 0.7333 },
              12: { n: 15, two_sided: 0.6667, at_or_below_upper: 0.8, at_or_above_lower: 0.8667 },
            },
            average: { two_sided: 0.6667, at_or_below_upper: 0.9056, at_or_above_lower: 0.7611 },
          },
          'SARIMA(1, 0, 0)x(0, 1, 1, 12)': {
            has_interval: true,
            by_horizon: {
              1: { n: 15, two_sided: 0.8667, at_or_below_upper: 0.9333, at_or_above_lower: 0.9333 },
              12: { n: 15, two_sided: 0.8667, at_or_below_upper: 0.9333, at_or_above_lower: 0.9333 },
            },
            average: { two_sided: 0.8778, at_or_below_upper: 0.95, at_or_above_lower: 0.9278 },
          },
        },
      },
      error_analysis: {
        models: {
          'Prophet (defaults)': {
            mape_by_season: { winter: 3.19, summer: 5.92, other: 5.22 },
            worst_months: [{ date: '2023-06-01', actual: 19_267_571, forecast: 23_066_425, pct_error: -19.72 }],
          },
        },
      },
      protocol: {
        protocol_date: '26 October 2026 (01:58 EAT)',
        train_period: '2014-01 to 2022-06 (102 months)',
        test_period: '2022-07 to 2024-08 (26 months)',
        outlier_rule: 'Five outlier months were interpolated using a centered 13-month rolling median.',
        models_compared: ['Prophet (defaults)', 'SARIMA(1, 0, 0)x(0, 1, 1, 12)'],
        chosen_sarima_order: [1, 0, 0],
        chosen_sarima_seasonal_order: [0, 1, 1, 12],
      },
    },
    unavailable: [],
    provenance: [
      { section: 'test_set_metrics', file: 'ml/results/sarima_test_comparison.json' },
      { section: 'rolling_origin', file: 'ml/results/rolling_evaluation_summary.json' },
    ],
    // Computed server-side (backend/modelEvaluation.js's buildVerdict) from
    // the test_set_metrics and diebold_mariano sections above — mirrored
    // here by hand since this fixture stands in for the whole API response.
    // Neither DM pair above (p = 0.41, p = 0.88) clears p < 0.05, so the
    // verdict must say the advantage over SARIMA isn't significant.
    verdict: {
      best: 'Prophet (defaults)',
      best_mape: 4.86,
      baseline_name: null,
      baseline_mape: null,
      baseline_models_tested: ['SARIMA(1, 0, 0)x(0, 1, 1, 12)'],
      baseline_horizons_tested: [1, 12],
      significant_against_baseline: [],
      significant_variant_differences: [],
    },
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

// A second fixture, dedicated to the "In short" card: it needs a stored
// baseline (Seasonal-naive) in both test_set_metrics and rolling_origin so
// buildShortFacts' 1-3-month-vs-12-month fact has something to compare
// against. The rolling means below are the real figures read from
// ml/results/rolling_evaluation_summary.json (Prophet defaults vs
// Seasonal-naive) — close at 1 and 3 months, a clear gap at 12.
function bodyWithBaseline() {
  const body = fullEvaluationBody();
  body.sections.test_set_metrics.models['Seasonal-naive'] = { mae: 1_177_106, rmse: 1_483_668, mape: 5.47 };
  body.sections.rolling_origin.models['Seasonal-naive'] = {
    1: { mean_mape: 4.78, min_abs_pct_error: 0.5, median_abs_pct_error: 4.0, max_abs_pct_error: 12.0, n_origins: 15 },
    3: { mean_mape: 4.34, min_abs_pct_error: 0.4, median_abs_pct_error: 3.8, max_abs_pct_error: 11.0, n_origins: 15 },
    6: { mean_mape: 4.72, min_abs_pct_error: 0.6, median_abs_pct_error: 4.2, max_abs_pct_error: 13.0, n_origins: 15 },
    12: { mean_mape: 5.91, min_abs_pct_error: 0.9, median_abs_pct_error: 5.5, max_abs_pct_error: 16.0, n_origins: 15 },
  };
  body.sections.diebold_mariano.pairs.push(
    { model_a: 'Prophet (defaults)', model_b: 'Seasonal-naive', horizon: 1, n: 15, dm_statistic: 0.98, p_value: 0.345 },
    { model_a: 'Prophet (defaults)', model_b: 'Seasonal-naive', horizon: 12, n: 15, dm_statistic: -0.24, p_value: 0.812 }
  );
  body.verdict = {
    best: 'Prophet (defaults)',
    best_mape: 4.86,
    baseline_name: 'Seasonal-naive',
    baseline_mape: 5.47,
    baseline_models_tested: ['SARIMA(1, 0, 0)x(0, 1, 1, 12)', 'Seasonal-naive'],
    baseline_horizons_tested: [1, 12],
    significant_against_baseline: [],
    significant_variant_differences: [],
  };
  return body;
}

test('renders the test-set metrics table and a data-driven verdict that flags a non-significant difference', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();

  await waitFor(() => expect(screen.getByText('How accurate is it?')).toBeInTheDocument());
  expect(screen.getAllByText('Prophet (defaults)').length).toBeGreaterThan(0);
  // Lowest MAPE model named in the verdict, and — since neither DM pair
  // involving it has p < 0.05 — the verdict must say so explicitly rather
  // than implying a clean win.
  expect(screen.getByText(/not statistically significant/i)).toBeInTheDocument();
});

test('shows real one-sided coverage ("about 9 in 10" / "about 8 in 10") for all models, not an unavailable notice', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();

  await waitFor(() => expect(screen.getByText('Can you trust the range?')).toBeInTheDocument());

  // Prophet (defaults): at_or_below_upper is 0.9333 at 1 mo, 0.8 at 12 mo.
  // The number itself is in its own <b>, so check it and its surrounding
  // "about ... months at a ...-month horizon" wording separately.
  const ninInTen = screen.getByText('9 in 10');
  expect(ninInTen.closest('div').textContent).toMatch(/about 9 in 10 months at a 1-month horizon/);
  const eightInTen = screen.getByText('8 in 10');
  expect(eightInTen.closest('div').textContent).toMatch(/about 8 in 10 months at a 12-month horizon/);

  // The coverage table lists every model present in the data, including SARIMA.
  expect(screen.getAllByText(/SARIMA\(1, 0, 0\)/).length).toBeGreaterThan(0);
  expect(screen.getByText(/better calibrated than Prophet/i)).toBeInTheDocument();
});

test('a partial response renders the available sections and a calm "not available" notice for the rest, not an error', async () => {
  const body = fullEvaluationBody();
  delete body.sections.coverage;
  delete body.sections.error_analysis;
  body.unavailable = [
    { section: 'coverage', reason: 'File not found' },
    { section: 'error_analysis', reason: 'File not found' },
  ];
  mockFetch(body);
  renderPage();

  await waitFor(() => expect(screen.getByText('How accurate is it?')).toBeInTheDocument());
  // Available sections still render normally.
  expect(screen.getByText('Is the difference real?')).toBeInTheDocument();
  // Missing ones get a calm notice, not an error banner.
  expect(screen.getAllByText(/isn't available from the stored evaluation files/i).length).toBe(2);
  expect(screen.queryByText("The model evaluation couldn't be loaded.")).not.toBeInTheDocument();
});

test('the protocol section states the train/test periods and that the test set was never used for tuning', async () => {
  mockFetch(fullEvaluationBody());
  renderPage();

  await waitFor(() => expect(screen.getByText('Was the test fair?')).toBeInTheDocument());
  expect(screen.getByText(/2014-01 to 2022-06/)).toBeInTheDocument();
  expect(screen.getByText(/never used to choose or tune any model/i)).toBeInTheDocument();
});

test('the "In short" card shows 4 plain-language facts built from the stored data', async () => {
  mockFetch(bodyWithBaseline());
  renderPage();

  const inShort = await screen.findByText('In short');
  const items = inShort.closest('section').querySelectorAll('li');
  expect(items.length).toBe(4);

  const text = inShort.closest('section').textContent;
  // Fact 1: typical error, from the deployed model's test-set MAPE (4.86 -> 5).
  expect(text).toMatch(/within about 5% of actual demand/);
  // Fact 2: one-sided coverage, reusing the same real numbers verified elsewhere on the page.
  expect(text).toMatch(/held about 9 in 10 months.*about 8 in 10.*12-month horizon/);
  expect(text).toMatch(/why the safe production plan uses it/);
  // Fact 3: short-horizon parity vs. the 12-month advantage, from the rolling-origin means.
  expect(text).toMatch(/same as last year.*as accurate or slightly more accurate/);
  expect(text).toMatch(/model's advantage shows at 12 months/);
  // Fact 4: the lower end is optimistic, because lower-bound violations (1 - 0.7611 = 23.9%)
  // outnumber upper-bound violations (1 - 0.9056 = 9.4%) in the same stored coverage data.
  expect(text).toMatch(/lower end of the range as optimistic/);
});

test('the "In short" card is omitted when none of its underlying data is available', async () => {
  mockFetch({ sections: {}, unavailable: [], provenance: [] });
  renderPage();

  await waitFor(() => expect(screen.getByText('No evaluation results are available')).toBeInTheDocument());
  expect(screen.queryByText('In short')).not.toBeInTheDocument();
});

test('"Technical details" starts collapsed, and opening it updates the URL hash', async () => {
  mockFetch(fullEvaluationBody());
  renderPageWithHashProbe();

  await waitFor(() => expect(screen.getByText('How accurate is it?')).toBeInTheDocument());

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

  await waitFor(() => expect(screen.getByText('How accurate is it?')).toBeInTheDocument());
  const details = screen.getByText('Technical details').closest('details');
  expect(details.open).toBe(true);
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
