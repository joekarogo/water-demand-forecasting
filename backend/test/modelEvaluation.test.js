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
  loadConformal,
  loadEnsembleConformal,
  loadEnsemble,
  loadOtherInputs,
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
        'Seasonal-naive': { 1: 4.78, 3: 4.34, 6: 4.72, 12: 5.91 },
        'Last-year x growth': { 1: 4.99, 3: 4.28, 6: 4.76, 12: 5.33 },
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

  const conformalMetric = (atOrBelowUpper1, atOrBelowUpper12) => ({
    1: { two_sided_coverage_pct: 80, at_or_below_upper_coverage_pct: atOrBelowUpper1, mean_width_pct: 18, n: 15 },
    12: { two_sided_coverage_pct: 73, at_or_below_upper_coverage_pct: atOrBelowUpper12, mean_width_pct: 16, n: 15 },
  });
  write(
    dir,
    'conformal_calibration.json',
    JSON.stringify({
      test_evaluation: {
        metrics_by_horizon: {
          prophet_raw: conformalMetric(100, 80),
          prophet_conformal: conformalMetric(100, 80),
          sarima: conformalMetric(93.3, 86.7),
        },
        metrics_average: {
          prophet_raw: { two_sided_coverage_pct: 89.4, at_or_below_upper_coverage_pct: 96.7, mean_width_pct: 18.0 },
          prophet_conformal: { two_sided_coverage_pct: 89.4, at_or_below_upper_coverage_pct: 96.7, mean_width_pct: 18.0 },
          sarima: { two_sided_coverage_pct: 87.8, at_or_below_upper_coverage_pct: 95.0, mean_width_pct: 19.7 },
        },
      },
    })
  );

  write(
    dir,
    'ensemble_conformal.json',
    JSON.stringify({
      test_evaluation: {
        metrics_by_horizon: { ensemble_conformal: conformalMetric(93.3, 80.0) },
        metrics_average: { ensemble_conformal: { two_sided_coverage_pct: 86.1, at_or_below_upper_coverage_pct: 94.4, mean_width_pct: 15.9 } },
      },
      run_timestamp: '2026-11-11T07:35:14.003150+00:00',
    })
  );

  write(
    dir,
    'ensemble_experiment.json',
    JSON.stringify({
      sarima_label: 'SARIMA(1, 0, 0)x(0, 1, 1, 12)',
      rolling: {
        mape_by_horizon: {
          'Ensemble (50/50)': { 1: 4.68, 12: 4.47 },
          'Prophet (defaults)': { 1: 5.66, 12: 4.62 },
          'SARIMA(1, 0, 0)x(0, 1, 1, 12)': { 1: 4.72, 12: 5.91 },
        },
      },
      test_evaluation: {
        metrics: {
          'Ensemble (50/50)': { mae: 892175, rmse: 1190331, mape: 4.1 },
          'Prophet (defaults)': { mae: 1027291, rmse: 1308929, mape: 4.86 },
          'SARIMA(1, 0, 0)x(0, 1, 1, 12)': { mae: 1127920, rmse: 1406426, mape: 5.25 },
        },
      },
      dm_results: {
        vs_prophet: { 1: { n: 15, dm_statistic: -1.6, p_value: 0.13 }, 6: { n: 15, dm_statistic: -1.5, p_value: 0.15 }, 12: { n: 15, dm_statistic: -1.1, p_value: 0.29 } },
        vs_sarima: { 1: { n: 15, dm_statistic: -0.01, p_value: 0.99 }, 6: { n: 15, dm_statistic: 0.14, p_value: 0.89 }, 12: { n: 15, dm_statistic: -0.74, p_value: 0.47 } },
      },
      run_timestamp: '2026-11-10T22:36:21.990574+00:00',
    })
  );

  write(
    dir,
    'exog_experiments.json',
    JSON.stringify({
      results_by_variant: {
        'E2 weather (normals)': { test_metrics: { mape: 4.78 }, rolling_by_horizon: { 12: { mape: 4.69 } } },
        'E2 weather (actual, best case)': { test_metrics: { mape: 4.87 }, rolling_by_horizon: { 12: { mape: 4.26 } } },
        'E3 Bayram days': { test_metrics: { mape: 5.04 }, rolling_by_horizon: { 12: { mape: 4.94 } } },
      },
      selection_outcomes: {
        'E2 weather (normals)': { wins: false },
        'E3 Bayram days': { wins: false },
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

test('loadConformal: reshapes prophet_raw/prophet_conformal/sarima from the stored E1 file', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadConformal(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.prophet_conformal.by_horizon[1].at_or_below_upper_coverage_pct, 100);
  assert.strictEqual(result.data.sarima.average.two_sided_coverage_pct, 87.8);
});

test('loadConformal: a missing file is reported unavailable, not a crash', () => {
  const dir = makeFixtureDir();
  const result = loadConformal(dir);
  assert.strictEqual(result.ok, false);
});

test('loadEnsembleConformal: reads the ensemble\'s own calibrated range and run_timestamp', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadEnsembleConformal(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.ensemble_conformal.average.at_or_below_upper_coverage_pct, 94.4);
  assert.strictEqual(result.data.run_timestamp, '2026-11-11T07:35:14.003150+00:00');
});

test('loadEnsembleConformal: a missing file is reported unavailable, not a crash', () => {
  const dir = makeFixtureDir();
  const result = loadEnsembleConformal(dir);
  assert.strictEqual(result.ok, false);
});

test('loadEnsemble: merges the ensemble\'s own test/rolling/DM results with the two baselines\' full rolling MAPE', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadEnsemble(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.sarima_label, 'SARIMA(1, 0, 0)x(0, 1, 1, 12)');
  assert.strictEqual(result.data.test_metrics['Ensemble (50/50)'].mape, 4.1);
  assert.strictEqual(result.data.rolling_mape_by_horizon['Ensemble (50/50)'][1], 4.68);
  // The two baselines are never ensembled, so their full rolling MAPE is
  // merged in from rolling_evaluation_summary.json, not invented here.
  assert.strictEqual(result.data.rolling_mape_by_horizon['Seasonal-naive'][12], 5.91);
  assert.strictEqual(result.data.rolling_mape_by_horizon['Last-year x growth'][1], 4.99);
  assert.strictEqual(result.data.dm_vs_prophet[1].p_value, 0.13);
  assert.strictEqual(result.data.dm_vs_sarima[12].p_value, 0.47);
  assert.deepStrictEqual(result.file, ['ml/results/ensemble_experiment.json', 'ml/results/rolling_evaluation_summary.json']);
});

test('loadEnsemble: a missing file is reported unavailable, not a crash', () => {
  const dir = makeFixtureDir();
  const result = loadEnsemble(dir);
  assert.strictEqual(result.ok, false);
});

test('loadEnsemble: still works (minus the two baselines) if rolling_evaluation_summary.json is missing', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  fs.unlinkSync(path.join(dir, 'rolling_evaluation_summary.json'));
  const result = loadEnsemble(dir);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.data.rolling_mape_by_horizon['Seasonal-naive'], undefined);
  assert.strictEqual(result.file, 'ml/results/ensemble_experiment.json');
});

test('loadOtherInputs: reads the two eligible variants and excludes the "best case" weather variant', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const result = loadOtherInputs(dir);
  assert.strictEqual(result.ok, true);
  const names = result.data.items.map((i) => i.name);
  assert.deepStrictEqual(names, ['Weather (typical for the month)', 'Bayram holiday days']);
  assert.ok(!names.some((n) => /best case/i.test(n)));
  assert.strictEqual(result.data.items[0].adopted, false);
});

test('loadOtherInputs: "adopted" is read live from selection_outcomes.wins, never assumed false', () => {
  const dir = makeFixtureDir();
  writeFullFixtures(dir);
  const file = path.join(dir, 'exog_experiments.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.selection_outcomes['E2 weather (normals)'].wins = true;
  fs.writeFileSync(file, JSON.stringify(data));
  const result = loadOtherInputs(dir);
  assert.strictEqual(result.data.items[0].adopted, true);
});

test('loadOtherInputs: a missing file is reported unavailable, not a crash', () => {
  const dir = makeFixtureDir();
  const result = loadOtherInputs(dir);
  assert.strictEqual(result.ok, false);
});

test('loadModelEvaluation: a totally empty directory marks every section unavailable, never throws', () => {
  const dir = makeFixtureDir();
  const result = loadModelEvaluation(dir);
  assert.strictEqual(Object.keys(result.sections).length, 0);
  assert.strictEqual(result.unavailable.length, 10);
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
  assert.strictEqual(Object.keys(result.sections).length, 10);
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
