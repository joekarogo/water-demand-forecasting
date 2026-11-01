const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadModelEvaluation,
  loadTestSetMetrics,
  loadRollingOrigin,
  loadDieboldMariano,
  loadCoverage,
  loadErrorAnalysis,
  loadProtocol,
} = require('../modelEvaluation');

function makeFixtureDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-eval-fixture-'));
}

function write(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}

function writeFullFixtures(dir) {
  write(
    dir,
    'sarima_test_comparison.json',
    JSON.stringify({
      chosen_sarima_order: [1, 0, 0],
      chosen_sarima_seasonal_order: [0, 1, 1, 12],
      metrics: {
        'SARIMA(1, 0, 0)x(0, 1, 1, 12)': { mae: 1_000_000, rmse: 1_300_000, mape: 5.0 },
        'Prophet (defaults)': { mae: 900_000, rmse: 1_200_000, mape: 4.5 },
      },
    })
  );
  write(
    dir,
    'rolling_evaluation_summary.json',
    JSON.stringify({
      origins: ['2022-06-01', '2022-07-01'],
      mape_by_horizon: {
        'Prophet (defaults)': { 1: 5.0, 3: 5.2, 6: 5.1, 12: 4.9 },
      },
      coverage_by_horizon: {
        'Prophet (defaults)': { 1: 0.6667, 12: 0.6667 },
      },
      interval_width: 0.8,
      coverage_caveat: 'Overlapping origins are not independent.',
    })
  );
  write(
    dir,
    'rolling_evaluation_predictions.csv',
    [
      'origin,horizon,target_month,model,actual,yhat,lower,upper,abs_pct_error',
      '2022-06-01,1,2022-07-01,Prophet (defaults),100,95,90,100,5.0',
      '2022-07-01,1,2022-08-01,Prophet (defaults),100,110,100,120,10.0',
      '2022-06-01,3,2022-09-01,Prophet (defaults),100,95,90,100,5.0',
      '2022-06-01,6,2022-12-01,Prophet (defaults),100,95,90,100,5.0',
      '2022-06-01,12,2023-06-01,Prophet (defaults),100,95,90,100,5.0',
    ].join('\n')
  );
  write(
    dir,
    'significance_testing_results.json',
    JSON.stringify({
      results: [{ model_a: 'Prophet (defaults)', model_b: 'SARIMA(1, 0, 0)x(0, 1, 1, 12)', horizon: 1, n: 15, dm_statistic: 0.8, p_value: 0.4 }],
      caveats: ['h=12 is indicative only.'],
    })
  );
  write(
    dir,
    'error_analysis.json',
    JSON.stringify({
      'Prophet (defaults)': {
        mape_by_season: { winter: 3.0, summer: 6.0, other: 5.0 },
        worst_months: [{ date: '2023-06-01', actual: 100, forecast: 120, pct_error: -20 }],
      },
    })
  );
}

test('loadTestSetMetrics: reads MAE/RMSE/MAPE per model', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadTestSetMetrics(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.models['Prophet (defaults)'].mape, 4.5);
  assert.deepStrictEqual(result.data.chosen_sarima_order, [1, 0, 0]);
});

test('loadTestSetMetrics: a missing file is reported unavailable, not a crash', () => {
  const dir = makeFixtureDir();
  const result = loadTestSetMetrics(dir);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /not found/i);
});

test('loadTestSetMetrics: malformed JSON is rejected with a clear reason', () => {
  const dir = makeFixtureDir();
  write(dir, 'sarima_test_comparison.json', '{ not valid json');
  const result = loadTestSetMetrics(dir);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /invalid json/i);
});

test('loadTestSetMetrics: wrong shape (missing "metrics") is rejected, not passed through', () => {
  const dir = makeFixtureDir();
  write(dir, 'sarima_test_comparison.json', JSON.stringify({ chosen_sarima_order: [1, 0, 0] }));
  const result = loadTestSetMetrics(dir);
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /metrics/i);
});

test('loadTestSetMetrics: a model with a non-numeric metric is rejected', () => {
  const dir = makeFixtureDir();
  write(dir, 'sarima_test_comparison.json', JSON.stringify({ metrics: { Prophet: { mae: 'oops', rmse: 1, mape: 1 } } }));
  const result = loadTestSetMetrics(dir);
  assert.strictEqual(result.ok, false);
});

test('loadRollingOrigin: mean comes from the summary; min/median/max/n come from the predictions CSV', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadRollingOrigin(dir);
  assert.strictEqual(result.ok, true);
  const h1 = result.data.models['Prophet (defaults)'][1];
  assert.strictEqual(h1.mean_mape, 5.0);
  assert.strictEqual(h1.min_abs_pct_error, 5.0);
  assert.strictEqual(h1.max_abs_pct_error, 10.0);
  assert.strictEqual(h1.median_abs_pct_error, 7.5);
  assert.strictEqual(h1.n_origins, 2);
});

test('loadRollingOrigin: missing predictions CSV is reported unavailable', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  fs.unlinkSync(path.join(dir, 'rolling_evaluation_predictions.csv'));
  const result = loadRollingOrigin(dir);
  assert.strictEqual(result.ok, false);
});

test('loadDieboldMariano: reads pairs and caveats', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadDieboldMariano(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.pairs.length, 1);
  assert.strictEqual(result.data.pairs[0].p_value, 0.4);
});

test('loadCoverage: reports two-sided coverage from the summary, and one-sided coverage counted from the predictions CSV', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadCoverage(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.two_sided_by_model_horizon['Prophet (defaults)'][1], 0.6667);

  // One-sided coverage isn't pre-aggregated in any ml/results file, but
  // IS counted here from the raw actual/lower/upper columns already
  // stored in rolling_evaluation_predictions.csv.
  assert.strictEqual(result.data.one_sided_available, true);
  const prophet = result.data.one_sided_by_model['Prophet (defaults)'];
  // Every fixture row has actual=100 sitting inside [lower, upper], so
  // every share is exactly 1.0 at every stored horizon.
  assert.strictEqual(prophet.by_horizon[1].n, 2);
  assert.strictEqual(prophet.by_horizon[1].at_or_below_upper, 1);
  assert.strictEqual(prophet.average.at_or_below_upper, 1);
  assert.strictEqual(prophet.average.two_sided, 1);
});

test('loadCoverage: one-sided coverage is unavailable (not crashed, not invented) when the predictions CSV is missing', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  fs.unlinkSync(path.join(dir, 'rolling_evaluation_predictions.csv'));
  const result = loadCoverage(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.one_sided_available, false);
  assert.strictEqual(result.data.one_sided_by_model, null);
  // The two-sided figures (from the summary JSON, unaffected) still load.
  assert.strictEqual(result.data.two_sided_by_model_horizon['Prophet (defaults)'][1], 0.6667);
});

test('loadErrorAnalysis: reads mape_by_season and worst_months per model', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadErrorAnalysis(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.models['Prophet (defaults)'].mape_by_season.winter, 3.0);
  assert.strictEqual(result.data.models['Prophet (defaults)'].worst_months.length, 1);
});

test('loadProtocol: models_compared comes from the stored metrics keys, not invented', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadProtocol(dir);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.data.models_compared, ['SARIMA(1, 0, 0)x(0, 1, 1, 12)', 'Prophet (defaults)']);
  assert.deepStrictEqual(result.data.chosen_sarima_order, [1, 0, 0]);
});

test('loadModelEvaluation: a totally empty directory marks every section unavailable, never throws', () => {
  const dir = makeFixtureDir();
  const result = loadModelEvaluation(dir);
  assert.strictEqual(Object.keys(result.sections).length, 0);
  assert.strictEqual(result.unavailable.length, 6);
});

test('loadModelEvaluation: a partially-populated directory returns the available sections and lists the rest as unavailable', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  fs.unlinkSync(path.join(dir, 'error_analysis.json'));
  const result = loadModelEvaluation(dir);
  assert.ok(result.sections.test_set_metrics);
  assert.ok(result.sections.rolling_origin);
  assert.ok(!result.sections.error_analysis);
  assert.ok(result.unavailable.some((u) => u.section === 'error_analysis'));
  assert.ok(result.provenance.some((p) => p.section === 'test_set_metrics'));
});

test('loadModelEvaluation: the real ml/results directory in this repo loads every section with no gaps', () => {
  const realDir = path.join(__dirname, '..', '..', 'ml', 'results');
  const result = loadModelEvaluation(realDir);
  assert.deepStrictEqual(result.unavailable, []);
  assert.strictEqual(Object.keys(result.sections).length, 6);
});

// rolling_evaluation_predictions.csv quotes the SARIMA model name because
// it contains commas of its own ("SARIMA(1, 0, 0)x(0, 1, 1, 12)"). A naive
// comma-split CSV reader misparses every SARIMA row because of this, so
// this test deliberately reads the REAL file (not a fixture with a
// simplified model name) to prove the quoted-CSV parsing and the one-sided
// coverage counting are both correct against the actual data on disk.
test('loadCoverage: one-sided coverage counted from the real predictions CSV matches hand-checked figures for Prophet (defaults)', () => {
  const realDir = path.join(__dirname, '..', '..', 'ml', 'results');
  const result = loadCoverage(realDir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.one_sided_available, true);

  const prophet = result.data.one_sided_by_model['Prophet (defaults)'];
  assert.ok(prophet, 'Prophet (defaults) must be present in the real file');

  const close = (actual, expected, label) => {
    assert.ok(Math.abs(actual - expected) < 0.01, `${label}: expected ~${expected}, got ${actual}`);
  };

  assert.strictEqual(prophet.by_horizon[1].n, 15);
  assert.strictEqual(prophet.by_horizon[12].n, 15);
  close(prophet.by_horizon[1].at_or_below_upper, 0.933, 'horizon 1 at-or-below-upper');
  close(prophet.by_horizon[12].at_or_below_upper, 0.8, 'horizon 12 at-or-below-upper');
  close(prophet.average.at_or_below_upper, 0.905, 'average at-or-below-upper across all stored horizons');
  close(prophet.average.two_sided, 0.667, 'average two-sided coverage');

  // Every model stored in the file (including the quoted SARIMA name)
  // must parse into its own, non-empty bucket with the full n=15 origins
  // — proving the quoted comma inside the SARIMA model name didn't get
  // split apart and misattributed to another model/column.
  const sarimaKey = Object.keys(result.data.one_sided_by_model).find((k) => k.startsWith('SARIMA'));
  assert.ok(sarimaKey, 'the quoted SARIMA model name must parse as a single key');
  assert.strictEqual(result.data.one_sided_by_model[sarimaKey].by_horizon[1].n, 15);

  // SARIMA's intervals are, in fact, better calibrated than Prophet's on
  // this stored data — factual, not asserted for its own sake.
  assert.ok(result.data.one_sided_by_model[sarimaKey].average.two_sided > prophet.average.two_sided);
});
