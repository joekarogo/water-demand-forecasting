const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTariffCatalog, buildRevenueBreakdown, round2, cellKey } = require('../revenue');
const { validateScenarioRequest, scaleTariffCatalog, rescoreCell, buildScenarioMonth } = require('../revenueScenarios');

function buildCatalog() {
  const tariffRows = [
    { subscriber_type: 'KONUT ABONELERİ', band_min_m3: 0, band_max_m3: 4, price_per_m3: 16.74, wastewater_price_per_m3: 8.36 },
    { subscriber_type: 'KONUT ABONELERİ', band_min_m3: 4, band_max_m3: 10, price_per_m3: 32.35, wastewater_price_per_m3: 16.17 },
    { subscriber_type: 'KONUT ABONELERİ', band_min_m3: 10, band_max_m3: 20, price_per_m3: 41.37, wastewater_price_per_m3: 20.67 },
    { subscriber_type: 'KONUT ABONELERİ', band_min_m3: 20, band_max_m3: null, price_per_m3: 77.46, wastewater_price_per_m3: 38.72 },
    { subscriber_type: 'İŞYERİ ABONELERİ', band_min_m3: 0, band_max_m3: 10, price_per_m3: 20, wastewater_price_per_m3: 10 },
    { subscriber_type: 'İŞYERİ ABONELERİ', band_min_m3: 10, band_max_m3: 30, price_per_m3: 30, wastewater_price_per_m3: 15 },
    { subscriber_type: 'İŞYERİ ABONELERİ', band_min_m3: 30, band_max_m3: 60, price_per_m3: 40, wastewater_price_per_m3: 20 },
    { subscriber_type: 'İŞYERİ ABONELERİ', band_min_m3: 60, band_max_m3: null, price_per_m3: 50, wastewater_price_per_m3: 25 },
    // A third tariff type, so per_step mode's "only housing/workplace
    // change" claim has something else to leave alone.
    { subscriber_type: 'SANAYİ ABONELERİ', band_min_m3: 0, band_max_m3: null, price_per_m3: 25, wastewater_price_per_m3: 12 },
  ];
  return buildTariffCatalog(tariffRows);
}

function buildRows() {
  const rows = [];
  [2021, 2022, 2023].forEach((year) => {
    rows.push({ year, month: 1, district: 'Alpha', subscriber_type: 'KONUT', consumption_m3: 1000 });
    rows.push({ year, month: 1, district: 'Alpha', subscriber_type: 'İŞYERİ', consumption_m3: 500 });
    rows.push({ year, month: 1, district: 'Alpha', subscriber_type: 'SANAYİ', consumption_m3: 300 });
  });
  return rows;
}

function buildBaselineMonth() {
  const rows = buildRows();
  const cells = [
    { district: 'Alpha', subscriberType: 'KONUT' },
    { district: 'Alpha', subscriberType: 'İŞYERİ' },
    { district: 'Alpha', subscriberType: 'SANAYİ' },
  ];
  const subscribersByCell = new Map([
    ['Alpha\u0001KONUT', 100],
    ['Alpha\u0001İŞYERİ', 20],
    ['Alpha\u0001SANAYİ', 10],
  ]);
  const consumptionTypeToTariffType = new Map([
    ['KONUT', 'KONUT ABONELERİ'],
    ['İŞYERİ', 'İŞYERİ ABONELERİ'],
    ['SANAYİ', 'SANAYİ ABONELERİ'],
  ]);
  const tariffCatalog = buildCatalog();
  // "Housing" scope means the Konut customer_group, not the KONUT
  // ABONELERİ tariff_type — these two cells are deliberately set up to
  // agree (KONUT subscriber_type -> Konut group) so most tests are
  // unaffected by the distinction; the scope-divergence test below sets
  // up a case where they disagree.
  const customerGroupByKey = new Map([
    [cellKey('Alpha', 'KONUT'), 'Konut'],
    [cellKey('Alpha', 'İŞYERİ'), 'Konut Dışı'],
    [cellKey('Alpha', 'SANAYİ'), 'Sanayi'],
  ]);

  const { cells: baselineCells, totals: baselineTotals } = buildRevenueBreakdown({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 2_000_000,
    lowerM3: 1_800_000,
    upperM3: 2_200_000,
    subscribersByCell,
    consumptionTypeToTariffType,
    tariffCatalog,
  });

  return { baselineCells, baselineTotals, tariffCatalog, consumptionTypeToTariffType, customerGroupByKey };
}

test('validateScenarioRequest: rejects more than 2 scenarios', () => {
  const { valid, errors } = validateScenarioRequest({
    scenarios: [{ mode: 'uniform', uniform_pct: 0 }, { mode: 'uniform', uniform_pct: 0 }, { mode: 'uniform', uniform_pct: 0 }],
  });
  assert.strictEqual(valid, false);
  assert.ok(errors.scenarios);
});

test('validateScenarioRequest: rejects an out-of-range uniform_pct', () => {
  const { valid, errors } = validateScenarioRequest({ scenarios: [{ mode: 'uniform', uniform_pct: 500 }] });
  assert.strictEqual(valid, false);
  assert.ok(errors['scenarios[0].uniform_pct']);
});

test('validateScenarioRequest: rejects an out-of-range elasticity', () => {
  const { valid, errors } = validateScenarioRequest({
    scenarios: [{ mode: 'uniform', uniform_pct: 10, elasticity: -2 }],
  });
  assert.strictEqual(valid, false);
  assert.ok(errors['scenarios[0].elasticity']);
});

test('validateScenarioRequest: per_step mode requires 4-entry housing and workplace step arrays', () => {
  const { valid, errors } = validateScenarioRequest({
    scenarios: [{ mode: 'per_step', steps: { housing: [0, 10, 20], workplace: [0, 10, 20, 30] } }],
  });
  assert.strictEqual(valid, false);
  assert.ok(errors['scenarios[0].steps']);
});

test('validateScenarioRequest: accepts a valid uniform scenario and defaults elasticity_scope to housing', () => {
  const { valid, scenarios } = validateScenarioRequest({ scenarios: [{ mode: 'uniform', uniform_pct: 10 }] });
  assert.strictEqual(valid, true);
  assert.strictEqual(scenarios[0].elasticity, 0);
  assert.strictEqual(scenarios[0].elasticity_scope, 'housing');
});

test('validateScenarioRequest: accepts a valid per_step scenario with a note about scope', () => {
  const { valid, scenarios } = validateScenarioRequest({
    scenarios: [{ mode: 'per_step', steps: { housing: [0, 15, 25, 35], workplace: [0, 15, 25, 35] } }],
  });
  assert.strictEqual(valid, true);
  assert.match(scenarios[0].note, /housing/i);
});

test('buildScenarioMonth: zero % change and elasticity 0 reproduces the baseline exactly', () => {
  const { baselineCells, baselineTotals, tariffCatalog, consumptionTypeToTariffType, customerGroupByKey } = buildBaselineMonth();
  const scenario = { name: 'No change', mode: 'uniform', uniform_pct: 0, elasticity: 0, elasticity_scope: 'all' };

  const { totals } = buildScenarioMonth({
    baselineCells,
    baselineTotals,
    tariffCatalog,
    consumptionTypeToTariffType,
    customerGroupByKey,
    scenario,
  });

  assert.strictEqual(totals.total.mid, baselineTotals.total.mid);
  assert.strictEqual(totals.water.mid, baselineTotals.water.mid);
  assert.strictEqual(totals.wastewater.mid, baselineTotals.wastewater.mid);
});

test('buildScenarioMonth: a uniform +10% scenario with elasticity 0 gives exactly +10% revenue, with volume unchanged', () => {
  const { baselineCells, baselineTotals, tariffCatalog, consumptionTypeToTariffType, customerGroupByKey } = buildBaselineMonth();
  const scenario = { name: 'Plus 10', mode: 'uniform', uniform_pct: 10, elasticity: 0, elasticity_scope: 'all' };

  const { totals } = buildScenarioMonth({
    baselineCells,
    baselineTotals,
    tariffCatalog,
    consumptionTypeToTariffType,
    customerGroupByKey,
    scenario,
  });

  assert.strictEqual(totals.total.mid, round2(baselineTotals.total.mid * 1.1));
  assert.strictEqual(totals.water.mid, round2(baselineTotals.water.mid * 1.1));
  assert.strictEqual(totals.wastewater.mid, round2(baselineTotals.wastewater.mid * 1.1));
  // elasticity 0 -> no demand response -> total priced volume is unchanged.
  const baselineVolume = baselineCells.filter((c) => !c.not_priced_reason).reduce((s, c) => s + c.volume_m3, 0);
  const scenarioVolume = totals.volume_m3;
  assert.ok(Math.abs(scenarioVolume - baselineVolume) < 1e-6);
});

test('rescoreCell: elasticity -0.35 with a price rise lowers volume', () => {
  const { baselineCells, tariffCatalog } = buildBaselineMonth();
  const konut = baselineCells.find((c) => c.subscriber_type === 'KONUT');

  // +20% on every band -> scenario bands bought at the baseline use cost
  // more, so r > 1, and with a negative elasticity volume must fall.
  const scenarioBands = tariffCatalog.get('KONUT ABONELERİ').bands.map((b) => ({
    ...b,
    waterPrice: b.waterPrice * 1.2,
    wastewaterPrice: b.wastewaterPrice * 1.2,
  }));

  const result = rescoreCell(konut, scenarioBands, -0.35, true);
  assert.ok(result.price_ratio > 1, `expected price_ratio > 1, got ${result.price_ratio}`);
  assert.ok(result.volume_m3 < konut.volume_m3, `expected ${result.volume_m3} < ${konut.volume_m3}`);
});

test('rescoreCell: a cell outside the elasticity scope keeps its baseline volume even under a price change', () => {
  const { baselineCells, tariffCatalog } = buildBaselineMonth();
  const sanayi = baselineCells.find((c) => c.subscriber_type === 'SANAYİ');

  const scenarioBands = tariffCatalog.get('SANAYİ ABONELERİ').bands.map((b) => ({
    ...b,
    waterPrice: b.waterPrice * 1.5,
    wastewaterPrice: b.wastewaterPrice * 1.5,
  }));

  // inScope = false, as if elasticity_scope were "housing" and this cell
  // isn't KONUT -> price changes, but volume must not.
  const result = rescoreCell(sanayi, scenarioBands, -0.35, false);
  assert.ok(Math.abs(result.volume_m3 - sanayi.volume_m3) < 1e-9);
  assert.ok(result.total.mid > sanayi.total.mid); // still re-priced at the higher rate
});

test('buildScenarioMonth: per_step changes touch only housing/workplace bands; every other tariff type is byte-identical to baseline', () => {
  const { baselineCells, baselineTotals, tariffCatalog, consumptionTypeToTariffType, customerGroupByKey } = buildBaselineMonth();
  const scenario = {
    name: 'May 2025',
    mode: 'per_step',
    steps: { housing: [0, 15, 25, 35], workplace: [0, 15, 25, 35] },
    elasticity: 0,
    elasticity_scope: 'all',
  };

  const { cells } = buildScenarioMonth({
    baselineCells,
    baselineTotals,
    tariffCatalog,
    consumptionTypeToTariffType,
    customerGroupByKey,
    scenario,
  });

  const baselineSanayi = baselineCells.find((c) => c.subscriber_type === 'SANAYİ');
  const scenarioSanayi = cells.find((c) => c.subscriber_type === 'SANAYİ');
  assert.strictEqual(scenarioSanayi.total.mid, baselineSanayi.total.mid);
  assert.strictEqual(scenarioSanayi.volume_m3, baselineSanayi.volume_m3);

  const baselineKonut = baselineCells.find((c) => c.subscriber_type === 'KONUT');
  const scenarioKonut = cells.find((c) => c.subscriber_type === 'KONUT');
  assert.notStrictEqual(scenarioKonut.total.mid, baselineKonut.total.mid);
});

test('buildScenarioMonth: the not-priced share is carried over unchanged from the baseline', () => {
  const { baselineCells, baselineTotals, tariffCatalog, consumptionTypeToTariffType, customerGroupByKey } = buildBaselineMonth();
  const scenario = { name: 'Plus 10', mode: 'uniform', uniform_pct: 10, elasticity: -0.35, elasticity_scope: 'all' };

  const { totals } = buildScenarioMonth({
    baselineCells,
    baselineTotals,
    tariffCatalog,
    consumptionTypeToTariffType,
    customerGroupByKey,
    scenario,
  });

  assert.strictEqual(totals.not_priced_pct, baselineTotals.not_priced_pct);
  assert.strictEqual(totals.not_priced_volume_m3, baselineTotals.not_priced_volume_m3);
});

test('buildScenarioMonth: "housing" scope follows the Konut customer_group, not the KONUT ABONELERİ tariff_type', () => {
  // A cell billed under the WORKPLACE tariff (İŞYERİ ABONELERİ) but
  // classified as the Konut customer_group in consumption_detail — the
  // two axes deliberately disagree here. Scoping by tariff_type would
  // wrongly exclude it from "housing"; scoping by customer_group (the
  // fix) correctly includes it.
  const { baselineCells, baselineTotals, tariffCatalog, consumptionTypeToTariffType } = buildBaselineMonth();
  const customerGroupByKey = new Map([
    [cellKey('Alpha', 'KONUT'), 'Konut Dışı'], // tariff_type is housing, but group is NOT Konut
    [cellKey('Alpha', 'İŞYERİ'), 'Konut'], // tariff_type is workplace, but group IS Konut
    [cellKey('Alpha', 'SANAYİ'), 'Sanayi'],
  ]);
  const scenario = {
    name: 'Price rise',
    mode: 'uniform',
    uniform_pct: 20,
    elasticity: -0.35,
    elasticity_scope: 'housing',
  };

  const { cells } = buildScenarioMonth({
    baselineCells,
    baselineTotals,
    tariffCatalog,
    consumptionTypeToTariffType,
    customerGroupByKey,
    scenario,
  });

  const baselineKonutTariff = baselineCells.find((c) => c.subscriber_type === 'KONUT');
  const scenarioKonutTariff = cells.find((c) => c.subscriber_type === 'KONUT');
  // KONUT ABONELERİ tariff, but customer_group is Konut Dışı -> out of
  // "housing" scope -> price changes, but volume does not.
  assert.ok(Math.abs(scenarioKonutTariff.volume_m3 - baselineKonutTariff.volume_m3) < 1e-9);

  const baselineIsyeri = baselineCells.find((c) => c.subscriber_type === 'İŞYERİ');
  const scenarioIsyeri = cells.find((c) => c.subscriber_type === 'İŞYERİ');
  // İŞYERİ ABONELERİ tariff, but customer_group is Konut -> in "housing"
  // scope -> a price rise with negative elasticity must lower volume.
  assert.ok(
    scenarioIsyeri.volume_m3 < baselineIsyeri.volume_m3,
    `expected ${scenarioIsyeri.volume_m3} < ${baselineIsyeri.volume_m3}`
  );
});

test('scaleTariffCatalog: per_step mode leaves a third tariff type as the exact same object', () => {
  const { tariffCatalog } = buildBaselineMonth();
  const scenario = { mode: 'per_step', steps: { housing: [0, 15, 25, 35], workplace: [0, 15, 25, 35] } };
  const scaled = scaleTariffCatalog(tariffCatalog, scenario);
  assert.strictEqual(scaled.get('SANAYİ ABONELERİ'), tariffCatalog.get('SANAYİ ABONELERİ'));
});
