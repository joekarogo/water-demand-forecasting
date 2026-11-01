// Loader for the Model Evaluation page. Pure/testable: every function
// here takes a directory or file path as an argument and returns plain
// data — no caching, no database access. backend/app.js reads the real
// ml/results/ directory once at startup and caches the result; tests
// point these functions at fixture directories instead.
//
// This module never trains or re-evaluates anything — it only reads
// already-committed result files written by the ml/ scripts, and only
// ever reports values that are actually present in those files. If a
// file is missing or doesn't look like what it's supposed to, that
// section is marked unavailable instead of guessing.

const fs = require('fs');
const path = require('path');

// The evaluation protocol itself (train/test split, outlier rule) is
// documented as a fixed, dated comment in ml/eval_common.py rather than
// a separate JSON file — there is no dedicated protocol document in this
// repo. These constants are copied from that comment (and from the
// Dataset section of README.md for the outlier rule) rather than parsed
// from the .py file at runtime, since that file isn't a data format this
// loader should be parsing. If ml/eval_common.py's protocol comment ever
// changes, these must be updated to match.
const PROTOCOL = {
  protocol_date: '26 October 2026 (01:58 EAT)',
  train_period: '2014-01 to 2022-06 (102 months)',
  test_period: '2022-07 to 2024-08 (26 months)',
  outlier_rule:
    'Five outlier months (the Sep 2019 billing spike; the Apr-Jun 2020 COVID meter-reading suspension; Aug 2020) were interpolated using a centered 13-month rolling median, with values beyond 1.4x/below 0.6x the median treated as outliers and the rule fitted on the training period only.',
  source: 'ml/eval_common.py (protocol comment) and README.md (Dataset section, outlier rule)',
};

function readJson(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `File not found or unreadable: ${filePath}` };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (err) {
    return { ok: false, reason: `Invalid JSON in ${filePath}: ${err.message}` };
  }
}

// Minimal CSV reader for this repo's own result files. Handles the
// standard RFC4180 quoting that rolling_evaluation_predictions.csv
// actually needs: the SARIMA model name is written as a quoted field
// because it contains commas of its own, e.g. "SARIMA(1, 0, 0)x(0, 1, 1, 12)".
// A plain line.split(',') would cut that field apart and misalign every
// column after it for every SARIMA row — this parser tracks quote state
// per character instead, and un-escapes doubled quotes ("") inside a
// quoted field.
function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function readCsv(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `File not found or unreadable: ${filePath}` };
  }
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 1) {
    return { ok: false, reason: `Empty CSV: ${filePath}` };
  }
  const header = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => {
      row[h] = cells[i];
    });
    return row;
  });
  return { ok: true, data: rows };
}

// --- Section 1: test-set metrics (26-month held-out test set) ---------
function loadTestSetMetrics(resultsDir) {
  const file = path.join(resultsDir, 'sarima_test_comparison.json');
  const read = readJson(file);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { data } = read;
  if (!data || typeof data.metrics !== 'object' || data.metrics === null) {
    return { ok: false, reason: `${file}: missing "metrics" object` };
  }
  const models = {};
  for (const [model, m] of Object.entries(data.metrics)) {
    if (typeof m.mae !== 'number' || typeof m.rmse !== 'number' || typeof m.mape !== 'number') {
      return { ok: false, reason: `${file}: "${model}" is missing a numeric mae/rmse/mape` };
    }
    models[model] = { mae: m.mae, rmse: m.rmse, mape: m.mape };
  }
  if (Object.keys(models).length === 0) {
    return { ok: false, reason: `${file}: "metrics" has no models` };
  }
  return {
    ok: true,
    data: { models, chosen_sarima_order: data.chosen_sarima_order || null, chosen_sarima_seasonal_order: data.chosen_sarima_seasonal_order || null },
    file: 'ml/results/sarima_test_comparison.json',
  };
}

// --- Section 2: rolling-origin results ---------------------------------
const ROLLING_HORIZONS = [1, 3, 6, 12];

function median(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function loadRollingOrigin(resultsDir) {
  const summaryFile = path.join(resultsDir, 'rolling_evaluation_summary.json');
  const predictionsFile = path.join(resultsDir, 'rolling_evaluation_predictions.csv');

  const summaryRead = readJson(summaryFile);
  if (!summaryRead.ok) return { ok: false, reason: summaryRead.reason };
  const summary = summaryRead.data;
  if (!summary || typeof summary.mape_by_horizon !== 'object' || summary.mape_by_horizon === null) {
    return { ok: false, reason: `${summaryFile}: missing "mape_by_horizon" object` };
  }

  const predRead = readCsv(predictionsFile);
  if (!predRead.ok) return { ok: false, reason: predRead.reason };
  const predRows = predRead.data;
  const requiredCols = ['origin', 'horizon', 'model', 'abs_pct_error'];
  if (predRows.length === 0 || requiredCols.some((c) => !(c in predRows[0]))) {
    return { ok: false, reason: `${predictionsFile}: missing one of ${requiredCols.join(', ')}` };
  }

  const models = {};
  for (const [model, byHorizon] of Object.entries(summary.mape_by_horizon)) {
    const perHorizon = {};
    for (const h of ROLLING_HORIZONS) {
      const mean = byHorizon[String(h)];
      if (typeof mean !== 'number') continue; // this model doesn't have this horizon stored
      const errs = predRows
        .filter((r) => r.model === model && Number(r.horizon) === h && r.abs_pct_error !== '' && r.abs_pct_error !== undefined)
        .map((r) => Number(r.abs_pct_error))
        .filter((v) => Number.isFinite(v))
        .sort((a, b) => a - b);
      perHorizon[h] = {
        mean_mape: mean,
        min_abs_pct_error: errs.length ? errs[0] : null,
        median_abs_pct_error: errs.length ? median(errs) : null,
        max_abs_pct_error: errs.length ? errs[errs.length - 1] : null,
        n_origins: errs.length,
      };
    }
    models[model] = perHorizon;
  }

  return {
    ok: true,
    data: { models, n_origins_total: Array.isArray(summary.origins) ? summary.origins.length : null, coverage_caveat: summary.coverage_caveat || null },
    file: ['ml/results/rolling_evaluation_summary.json', 'ml/results/rolling_evaluation_predictions.csv'],
  };
}

// --- Section 3: Diebold-Mariano results --------------------------------
function loadDieboldMariano(resultsDir) {
  const file = path.join(resultsDir, 'significance_testing_results.json');
  const read = readJson(file);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { data } = read;
  if (!Array.isArray(data.results)) {
    return { ok: false, reason: `${file}: missing "results" array` };
  }
  const pairs = data.results.map((r) => ({
    model_a: r.model_a,
    model_b: r.model_b,
    horizon: r.horizon,
    n: r.n,
    dm_statistic: r.dm_statistic,
    p_value: r.p_value,
  }));
  return { ok: true, data: { pairs, caveats: Array.isArray(data.caveats) ? data.caveats : [] }, file: 'ml/results/significance_testing_results.json' };
}

// --- Section 4: interval coverage ---------------------------------------
// One-sided coverage (how often the actual stayed at-or-below the upper
// bound, or at-or-above the lower bound) isn't pre-aggregated anywhere in
// ml/results/ — but the raw actual/lower/upper values it needs ARE
// already stored, per origin/horizon/model, in
// rolling_evaluation_predictions.csv. This is deterministic counting over
// those already-computed, already-stored numbers (exactly like the
// min/median/max aggregation in loadRollingOrigin above) — not a
// re-evaluation of any model.
//
// The predictions file stores every monthly horizon from 1 through 12,
// not just the four "headline" horizons (ROLLING_HORIZONS) shown
// elsewhere on the page. The per-horizon breakdown returned here is
// still limited to those four, to match the rest of the page, but the
// "average" is deliberately computed across all 12 stored horizons —
// averaging over only 1/3/6/12 would quietly drop 8 months of real,
// stored evidence and gives a different (less accurate) figure.
function aggregateOneSidedCoverage(predRows) {
  // Some models stored in this file (the baselines with no prediction
  // interval, e.g. Seasonal-naive, Last-year x growth) have an empty
  // string in their lower/upper cells for every row. Number('') is 0, not
  // NaN, so a naive Number.isFinite check would silently treat "no
  // interval" as "interval = [0, 0]" and produce a bogus ~0% coverage.
  // hasIntervalValues below is what actually tells the two cases apart.
  const byModel = {};
  for (const row of predRows) {
    const model = row.model;
    if (!model) continue;
    if (!byModel[model]) byModel[model] = { byHorizon: {}, hasInterval: false };

    const horizon = Number(row.horizon);
    const actual = Number(row.actual);
    const hasIntervalValues = row.lower !== '' && row.lower !== undefined && row.upper !== '' && row.upper !== undefined;
    if (!Number.isFinite(horizon) || !Number.isFinite(actual) || !hasIntervalValues) continue;
    const lower = Number(row.lower);
    const upper = Number(row.upper);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) continue;

    byModel[model].hasInterval = true;
    const byHorizon = byModel[model].byHorizon;
    if (!byHorizon[horizon]) byHorizon[horizon] = { n: 0, twoSided: 0, atOrBelowUpper: 0, atOrAboveLower: 0 };
    const bucket = byHorizon[horizon];
    bucket.n += 1;
    if (actual <= upper) bucket.atOrBelowUpper += 1;
    if (actual >= lower) bucket.atOrAboveLower += 1;
    if (lower <= actual && actual <= upper) bucket.twoSided += 1;
  }

  const result = {};
  for (const [model, info] of Object.entries(byModel)) {
    if (!info.hasInterval) {
      // This model never has a prediction interval in the stored data —
      // coverage genuinely doesn't apply to it, so it's reported as such
      // rather than as a (misleading) 0%, and carries no average for any
      // cross-model aggregation to accidentally pick up.
      result[model] = {
        has_interval: false,
        by_horizon: {},
        average: { two_sided: null, at_or_below_upper: null, at_or_above_lower: null },
        average_n_horizons: 0,
      };
      continue;
    }
    const perHorizon = {};
    const horizonShares = { twoSided: [], atOrBelowUpper: [], atOrAboveLower: [] };
    for (const [hKey, bucket] of Object.entries(info.byHorizon)) {
      const h = Number(hKey);
      if (!bucket || bucket.n === 0) continue;
      const twoSidedShare = bucket.twoSided / bucket.n;
      const atOrBelowUpperShare = bucket.atOrBelowUpper / bucket.n;
      const atOrAboveLowerShare = bucket.atOrAboveLower / bucket.n;
      if (ROLLING_HORIZONS.includes(h)) {
        perHorizon[h] = {
          n: bucket.n,
          two_sided: twoSidedShare,
          at_or_below_upper: atOrBelowUpperShare,
          at_or_above_lower: atOrAboveLowerShare,
        };
      }
      // Every stored horizon (1-12) feeds the average, not just the four
      // headline ones above.
      horizonShares.twoSided.push(twoSidedShare);
      horizonShares.atOrBelowUpper.push(atOrBelowUpperShare);
      horizonShares.atOrAboveLower.push(atOrAboveLowerShare);
    }
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    result[model] = {
      has_interval: true,
      by_horizon: perHorizon,
      average: {
        two_sided: avg(horizonShares.twoSided),
        at_or_below_upper: avg(horizonShares.atOrBelowUpper),
        at_or_above_lower: avg(horizonShares.atOrAboveLower),
      },
      average_n_horizons: horizonShares.twoSided.length,
    };
  }
  return result;
}

function loadCoverage(resultsDir) {
  const file = path.join(resultsDir, 'rolling_evaluation_summary.json');
  const read = readJson(file);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { data } = read;
  if (!data || typeof data.coverage_by_horizon !== 'object' || data.coverage_by_horizon === null) {
    return { ok: false, reason: `${file}: missing "coverage_by_horizon" object` };
  }

  const predictionsFile = path.join(resultsDir, 'rolling_evaluation_predictions.csv');
  const predRead = readCsv(predictionsFile);
  let oneSidedByModel = null;
  let oneSidedFile = null;
  if (predRead.ok) {
    const predRows = predRead.data;
    const requiredCols = ['model', 'horizon', 'actual', 'lower', 'upper'];
    if (predRows.length > 0 && requiredCols.every((c) => c in predRows[0])) {
      oneSidedByModel = aggregateOneSidedCoverage(predRows);
      oneSidedFile = 'ml/results/rolling_evaluation_predictions.csv';
    }
  }

  return {
    ok: true,
    data: {
      two_sided_by_model_horizon: data.coverage_by_horizon,
      interval_width: data.interval_width ?? null,
      coverage_caveat: data.coverage_caveat || null,
      // One-sided coverage, counted directly from the stored
      // actual/lower/upper values per origin — see aggregateOneSidedCoverage
      // above. null when the predictions CSV wasn't available/valid.
      one_sided_available: oneSidedByModel !== null,
      one_sided_by_model: oneSidedByModel,
    },
    file: oneSidedFile ? ['ml/results/rolling_evaluation_summary.json', oneSidedFile] : 'ml/results/rolling_evaluation_summary.json',
  };
}

// --- Section 5: error analysis by season --------------------------------
function loadErrorAnalysis(resultsDir) {
  const file = path.join(resultsDir, 'error_analysis.json');
  const read = readJson(file);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { data } = read;
  if (!data || typeof data !== 'object') {
    return { ok: false, reason: `${file}: not an object` };
  }
  const models = {};
  for (const [model, v] of Object.entries(data)) {
    if (!v || typeof v.mape_by_season !== 'object') {
      return { ok: false, reason: `${file}: "${model}" is missing "mape_by_season"` };
    }
    models[model] = { mape_by_season: v.mape_by_season, worst_months: Array.isArray(v.worst_months) ? v.worst_months : [] };
  }
  return { ok: true, data: { models }, file: 'ml/results/error_analysis.json' };
}

// --- Section 6: protocol facts -------------------------------------------
function loadProtocol(resultsDir) {
  const file = path.join(resultsDir, 'sarima_test_comparison.json');
  const read = readJson(file);
  if (!read.ok) return { ok: false, reason: read.reason };
  const { data } = read;
  const modelsCompared = data && data.metrics ? Object.keys(data.metrics) : null;
  if (!modelsCompared) {
    return { ok: false, reason: `${file}: missing "metrics" object (needed for "models compared")` };
  }
  return {
    ok: true,
    data: {
      ...PROTOCOL,
      models_compared: modelsCompared,
      chosen_sarima_order: data.chosen_sarima_order || null,
      chosen_sarima_seasonal_order: data.chosen_sarima_seasonal_order || null,
    },
    file: PROTOCOL.source,
  };
}

// --- Verdict: a plain-language summary built strictly from the stored
// test-set metrics and Diebold-Mariano results, never asserting
// statistical significance against anything the DM data doesn't actually
// support at p < 0.05. --------------------------------------------------
function isSignificant(pValue) {
  return typeof pValue === 'number' && pValue < 0.05;
}

// Groups model names into "families" so a difference between two variants
// of the same underlying model (e.g. "Prophet (defaults)" vs
// "Prophet (CV-tuned)") is never mistaken for a difference against a
// baseline (e.g. "SARIMA(...)" or "Seasonal-naive").
function familyOf(modelName) {
  const m = /^[A-Za-z-]+/.exec(modelName || '');
  return m ? m[0] : modelName;
}

function describeDmPair(best, p) {
  const other = p.model_a === best ? p.model_b : p.model_a;
  // dm_statistic is built from d = e1^2 - e2^2 (e1 = model_a's errors):
  // negative means model_a had the lower squared error.
  const winner = typeof p.dm_statistic === 'number' ? (p.dm_statistic < 0 ? p.model_a : p.model_b) : null;
  return { other, horizon: p.horizon, p_value: p.p_value, winner };
}

function buildVerdict(testSetData, dmData) {
  if (!testSetData || !dmData) return null;
  const modelNames = Object.keys(testSetData.models);
  if (modelNames.length === 0) return null;

  const best = modelNames.reduce((a, b) => (testSetData.models[a].mape <= testSetData.models[b].mape ? a : b));
  const bestFamily = familyOf(best);
  const naiveName = modelNames.find((m) => /seasonal-naive/i.test(m)) || null;

  const pairsInvolvingBest = dmData.pairs.filter((p) => p.model_a === best || p.model_b === best);
  const baselinePairs = [];
  const variantPairs = [];
  for (const p of pairsInvolvingBest) {
    const other = p.model_a === best ? p.model_b : p.model_a;
    (familyOf(other) === bestFamily ? variantPairs : baselinePairs).push(p);
  }

  return {
    best,
    best_mape: testSetData.models[best].mape,
    baseline_name: naiveName,
    baseline_mape: naiveName ? testSetData.models[naiveName].mape : null,
    baseline_models_tested: [...new Set(baselinePairs.map((p) => (p.model_a === best ? p.model_b : p.model_a)))],
    baseline_horizons_tested: [...new Set(baselinePairs.map((p) => p.horizon))].sort((a, b) => a - b),
    significant_against_baseline: baselinePairs.filter((p) => isSignificant(p.p_value)).map((p) => describeDmPair(best, p)),
    significant_variant_differences: variantPairs.filter((p) => isSignificant(p.p_value)).map((p) => describeDmPair(best, p)),
  };
}

// --- Assembling the full response ----------------------------------------
const SECTION_LOADERS = {
  test_set_metrics: loadTestSetMetrics,
  rolling_origin: loadRollingOrigin,
  diebold_mariano: loadDieboldMariano,
  coverage: loadCoverage,
  error_analysis: loadErrorAnalysis,
  protocol: loadProtocol,
};

// resultsDir: directory holding the ml/results/*.json|csv files (real
// callers pass path.join(__dirname, '..', 'ml', 'results')).
function loadModelEvaluation(resultsDir) {
  const sections = {};
  const unavailable = [];
  const provenance = [];

  for (const [key, loader] of Object.entries(SECTION_LOADERS)) {
    const result = loader(resultsDir);
    if (result.ok) {
      sections[key] = result.data;
      const files = Array.isArray(result.file) ? result.file : [result.file];
      files.forEach((f) => provenance.push({ section: key, file: f }));
    } else {
      unavailable.push({ section: key, reason: result.reason });
    }
  }

  const verdict = buildVerdict(sections.test_set_metrics, sections.diebold_mariano);

  return { sections, unavailable, provenance, verdict };
}

module.exports = {
  PROTOCOL,
  loadModelEvaluation,
  loadTestSetMetrics,
  loadRollingOrigin,
  loadDieboldMariano,
  loadCoverage,
  loadErrorAnalysis,
  loadProtocol,
  ROLLING_HORIZONS,
  aggregateOneSidedCoverage,
  buildVerdict,
  familyOf,
};
