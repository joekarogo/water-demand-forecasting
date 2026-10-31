const test = require('node:test');
const assert = require('node:assert/strict');
const {
  listCells,
  buildCellVolumes,
  priceThroughBands,
  round2,
  buildTariffCatalog,
  buildRevenueBreakdown,
  buildGroupBreakdown,
  buildDistrictGroupBreakdown,
  cellKey,
} = require('../revenue');

// The exact KONUT bands from the live July-2024 tariff file (confirmed by
// reading database/su-atiksu-tarifeleri.csv directly: the SU rows for
// "KONUT ABONELERİ" carry both SU_FIYATI and ATIKSU_FIYATI).
const KONUT_WATER_BANDS = [
  { min: 0, max: 4, waterPrice: 16.74 },
  { min: 4, max: 10, waterPrice: 32.35 },
  { min: 10, max: 20, waterPrice: 41.37 },
  { min: 20, max: null, waterPrice: 77.46 },
];
const KONUT_WASTEWATER_BANDS = [
  { min: 0, max: 4, wastewaterPrice: 8.36 },
  { min: 4, max: 10, wastewaterPrice: 16.17 },
  { min: 10, max: 20, wastewaterPrice: 20.67 },
  { min: 20, max: null, wastewaterPrice: 38.72 },
];

test('priceThroughBands: hand-calculated KONUT case at 10.4 m3/subscriber/month', () => {
  const water = priceThroughBands(10.4, KONUT_WATER_BANDS, 'waterPrice');
  const wastewater = priceThroughBands(10.4, KONUT_WASTEWATER_BANDS, 'wastewaterPrice');
  // 4*16.74 + 6*32.35 + 0.4*41.37 = 66.96 + 194.10 + 16.548 = 277.608 -> 277.61
  assert.strictEqual(round2(water), 277.61);
  // 4*8.36 + 6*16.17 + 0.4*20.67 = 33.44 + 97.02 + 8.268 = 138.728 -> 138.73
  assert.strictEqual(round2(wastewater), 138.73);
});

test('priceThroughBands: only charges for the m3 inside each band, not the whole total at one rate', () => {
  // 3 m3, entirely inside the first (0-4) band, must be charged at that
  // band's rate only, not spill into the second band's rate.
  const amount = priceThroughBands(3, KONUT_WATER_BANDS, 'waterPrice');
  assert.strictEqual(round2(amount), round2(3 * 16.74));
});

test('priceThroughBands: zero usage prices to zero', () => {
  assert.strictEqual(priceThroughBands(0, KONUT_WATER_BANDS, 'waterPrice'), 0);
});

function buildCatalog() {
  const tariffRows = [
    { subscriber_type: 'KONUT ABONELERİ', band_min_m3: 0, band_max_m3: 4, price_per_m3: 16.74, wastewater_price_per_m3: 8.36 },
    { subscriber_type: 'KONUT ABONELERİ', band_min_m3: 4, band_max_m3: 10, price_per_m3: 32.35, wastewater_price_per_m3: 16.17 },
    { subscriber_type: 'KONUT ABONELERİ', band_min_m3: 10, band_max_m3: 20, price_per_m3: 41.37, wastewater_price_per_m3: 20.67 },
    { subscriber_type: 'KONUT ABONELERİ', band_min_m3: 20, band_max_m3: null, price_per_m3: 77.46, wastewater_price_per_m3: 38.72 },
    // A tariff_type with two different prices for the same band at the
    // same valid_from date — must be flagged ambiguous, not priced.
    { subscriber_type: 'AMBIGUOUS ABONELERİ', band_min_m3: 0, band_max_m3: null, price_per_m3: 10, wastewater_price_per_m3: 5 },
    { subscriber_type: 'AMBIGUOUS ABONELERİ', band_min_m3: 0, band_max_m3: null, price_per_m3: 12, wastewater_price_per_m3: 5 },
  ];
  return buildTariffCatalog(tariffRows);
}

test('buildTariffCatalog: flags a tariff_type with differing prices in the same band as ambiguous', () => {
  const catalog = buildCatalog();
  assert.strictEqual(catalog.get('KONUT ABONELERİ').ambiguous, false);
  assert.strictEqual(catalog.get('AMBIGUOUS ABONELERİ').ambiguous, true);
});

function buildRows({ districtTotals, months = [1, 9] }) {
  const rows = [];
  const yearsByMonth = { 1: [2021, 2022, 2023, 2024], 9: [2021, 2022, 2023] };
  months.forEach((month) => {
    yearsByMonth[month].forEach((year) => {
      Object.entries(districtTotals(year, month)).forEach(([key, consumption_m3]) => {
        const [district, subscriber_type] = key.split('|');
        rows.push({ year, month, district, subscriber_type, consumption_m3 });
      });
    });
  });
  return rows;
}

test('listCells and buildCellVolumes: shares split the city forecast across every (district, subscriber_type) cell', () => {
  const rows = buildRows({
    districtTotals: () => ({ 'Alpha|KONUT': 60, 'Alpha|İŞYERİ': 40, 'Beta|KONUT': 100 }),
    months: [1],
  });
  const cells = listCells(rows);
  assert.strictEqual(cells.length, 3);

  const { shareYears, volumes } = buildCellVolumes({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 2_000_000,
    lowerM3: 1_800_000,
    upperM3: 2_200_000,
  });
  assert.deepStrictEqual(shareYears, [2024, 2023, 2022]);

  const totalVolume = volumes.reduce((sum, v) => sum + v.volume_m3, 0);
  assert.ok(Math.abs(totalVolume - 2_000_000) < 1e-6, `expected ~2,000,000, got ${totalVolume}`);

  const alphaKonut = volumes.find((v) => v.district === 'Alpha' && v.subscriberType === 'KONUT');
  // Alpha|KONUT is 60 of 200 total -> 30% share.
  assert.ok(Math.abs(alphaKonut.share - 0.3) < 1e-9);
});

function buildFullCase() {
  const rows = buildRows({
    districtTotals: () => ({
      'Alpha|KONUT': 1000, // mapped, priced
      'Alpha|UNMAPPED_TYPE': 200, // no tariff_type_map entry
      'Alpha|AMBIGUOUS_TYPE': 150, // maps to an ambiguous tariff
      'Beta|NO_SUBS_TYPE': 50, // mapped and priced, but zero subscribers
    }),
    months: [1],
  });
  const cells = listCells(rows);

  const subscribersByCell = new Map([
    ['Alpha\u0001KONUT', 100],
    ['Alpha\u0001UNMAPPED_TYPE', 20],
    ['Alpha\u0001AMBIGUOUS_TYPE', 15],
    // Beta|NO_SUBS_TYPE intentionally has no entry -> null/0 subscribers.
  ]);

  const consumptionTypeToTariffType = new Map([
    ['KONUT', 'KONUT ABONELERİ'],
    ['AMBIGUOUS_TYPE', 'AMBIGUOUS ABONELERİ'],
    ['NO_SUBS_TYPE', 'KONUT ABONELERİ'],
    // UNMAPPED_TYPE deliberately absent.
  ]);

  const tariffCatalog = buildCatalog();

  return { rows, cells, subscribersByCell, consumptionTypeToTariffType, tariffCatalog };
}

test('buildRevenueBreakdown: unmapped, ambiguous and zero-subscriber cells are not priced', () => {
  const { rows, cells, subscribersByCell, consumptionTypeToTariffType, tariffCatalog } = buildFullCase();

  const { cells: priced } = buildRevenueBreakdown({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 10_000_000,
    lowerM3: 9_000_000,
    upperM3: 11_000_000,
    subscribersByCell,
    consumptionTypeToTariffType,
    tariffCatalog,
  });

  const unmapped = priced.find((c) => c.subscriber_type === 'UNMAPPED_TYPE');
  const ambiguous = priced.find((c) => c.subscriber_type === 'AMBIGUOUS_TYPE');
  const noSubs = priced.find((c) => c.subscriber_type === 'NO_SUBS_TYPE');
  const konut = priced.find((c) => c.subscriber_type === 'KONUT');

  assert.strictEqual(unmapped.not_priced_reason, 'unmapped');
  assert.strictEqual(unmapped.total.mid, 0);
  assert.strictEqual(ambiguous.not_priced_reason, 'ambiguous');
  assert.strictEqual(ambiguous.total.mid, 0);
  assert.strictEqual(noSubs.not_priced_reason, 'no_subscribers');
  assert.strictEqual(noSubs.total.mid, 0);

  assert.strictEqual(konut.not_priced_reason, null);
  assert.ok(konut.total.mid > 0);
});

test('buildRevenueBreakdown: low <= mid <= high for a priced cell', () => {
  const { rows, cells, subscribersByCell, consumptionTypeToTariffType, tariffCatalog } = buildFullCase();

  const { cells: priced } = buildRevenueBreakdown({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 10_000_000,
    lowerM3: 9_000_000,
    upperM3: 11_000_000,
    subscribersByCell,
    consumptionTypeToTariffType,
    tariffCatalog,
  });

  const konut = priced.find((c) => c.subscriber_type === 'KONUT');
  assert.ok(konut.total.low <= konut.total.mid, `${konut.total.low} should be <= ${konut.total.mid}`);
  assert.ok(konut.total.mid <= konut.total.high, `${konut.total.mid} should be <= ${konut.total.high}`);
  assert.ok(konut.volume_m3 > 0 && konut.lower_m3 <= konut.volume_m3 && konut.volume_m3 <= konut.upper_m3);
});

test('buildRevenueBreakdown: not-priced volume and percentage account for every unpriced cell', () => {
  const { rows, cells, subscribersByCell, consumptionTypeToTariffType, tariffCatalog } = buildFullCase();

  const { totals, cells: priced } = buildRevenueBreakdown({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 10_000_000,
    lowerM3: 9_000_000,
    upperM3: 11_000_000,
    subscribersByCell,
    consumptionTypeToTariffType,
    tariffCatalog,
  });

  const notPriced = priced.filter((c) => c.not_priced_reason);
  const expectedNotPricedVolume = notPriced.reduce((sum, c) => sum + c.volume_m3, 0);
  assert.ok(Math.abs(totals.not_priced_volume_m3 - expectedNotPricedVolume) < 1e-6);
  assert.ok(totals.not_priced_pct > 0 && totals.not_priced_pct < 100);
});

test('buildGroupBreakdown: group totals sum to exactly the month total', () => {
  const { rows, cells, subscribersByCell, consumptionTypeToTariffType, tariffCatalog } = buildFullCase();

  const { totals, cells: priced } = buildRevenueBreakdown({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 10_000_000,
    lowerM3: 9_000_000,
    upperM3: 11_000_000,
    subscribersByCell,
    consumptionTypeToTariffType,
    tariffCatalog,
  });

  const customerGroupByKey = new Map([
    ['Alpha\u0001KONUT', 'Konut'],
    ['Alpha\u0001UNMAPPED_TYPE', 'Konut Dışı'],
    ['Alpha\u0001AMBIGUOUS_TYPE', 'Sanayi'],
    ['Beta\u0001NO_SUBS_TYPE', 'Konut'],
  ]);

  const groups = buildGroupBreakdown(priced, customerGroupByKey);
  const groupTotalSum = round2(groups.reduce((sum, g) => sum + g.total_try, 0));
  assert.strictEqual(groupTotalSum, round2(totals.total.mid));
});

// Fix #1 regression test: a cell with zero/no subscribers in the latest
// data month (Beta|NO_SUBS_TYPE here) must still resolve to its real
// customer_group, never fall back to "Unknown" — this is the behavior
// backend/app.js now gets by looking up customer_group from
// consumption_detail across every month, not just the subscriber-count
// month, so a zero-subscriber cell is never missing from the map passed
// in here.
test('buildGroupBreakdown: a zero-subscriber cell keeps its real customer_group, never "Unknown"', () => {
  const { rows, cells, subscribersByCell, consumptionTypeToTariffType, tariffCatalog } = buildFullCase();

  const { cells: priced } = buildRevenueBreakdown({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 10_000_000,
    lowerM3: 9_000_000,
    upperM3: 11_000_000,
    subscribersByCell,
    consumptionTypeToTariffType,
    tariffCatalog,
  });

  const noSubs = priced.find((c) => c.subscriber_type === 'NO_SUBS_TYPE');
  assert.strictEqual(noSubs.subscribers, null); // confirms this cell truly has no subscriber-month data

  // customerGroupByKey still has an entry for it, as it would after the
  // app.js fix (looked up across all months, independent of subscribers).
  const customerGroupByKey = new Map([
    ['Alpha\u0001KONUT', 'Konut'],
    ['Alpha\u0001UNMAPPED_TYPE', 'Konut Dışı'],
    ['Alpha\u0001AMBIGUOUS_TYPE', 'Sanayi'],
    ['Beta\u0001NO_SUBS_TYPE', 'Konut'],
  ]);

  const groups = buildGroupBreakdown(priced, customerGroupByKey);
  const detail = buildDistrictGroupBreakdown(priced, customerGroupByKey);

  assert.ok(!groups.some((g) => g.customer_group === 'Unknown'));
  assert.ok(!detail.some((d) => d.customer_group === 'Unknown'));

  const betaRow = detail.find((d) => d.district === 'Beta');
  assert.strictEqual(betaRow.customer_group, 'Konut');
});

// Fix #1 counterpart: a cell truly absent from customerGroupByKey (e.g. a
// real data gap, not just a quiet one from scoping the lookup to a single
// month) must still fall back to "Unknown" rather than throwing or being
// silently dropped — the fix removes the FALSE "Unknown"s, not this one.
test('buildGroupBreakdown: a cell genuinely missing from customerGroupByKey still falls back to "Unknown"', () => {
  const { rows, cells, subscribersByCell, consumptionTypeToTariffType, tariffCatalog } = buildFullCase();

  const { cells: priced } = buildRevenueBreakdown({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 10_000_000,
    lowerM3: 9_000_000,
    upperM3: 11_000_000,
    subscribersByCell,
    consumptionTypeToTariffType,
    tariffCatalog,
  });

  const customerGroupByKey = new Map([['Alpha\u0001KONUT', 'Konut']]); // every other cell deliberately absent

  const groups = buildGroupBreakdown(priced, customerGroupByKey);
  assert.ok(groups.some((g) => g.customer_group === 'Unknown'));
});

// Fix #2 regression test: average_price_per_m3 must divide by PRICED
// volume only. Beta|NO_SUBS_TYPE is not-priced (zero subscribers) but has
// real volume > 0; grouping it together with the priced Alpha|KONUT cell
// under the same customer_group must not dilute the average price with
// that unpriced volume.
test('buildGroupBreakdown: average_price_per_m3 divides by priced volume only, not total volume', () => {
  const { rows, cells, subscribersByCell, consumptionTypeToTariffType, tariffCatalog } = buildFullCase();

  const { cells: priced } = buildRevenueBreakdown({
    consumptionRows: rows,
    cells,
    calendarMonth: 1,
    forecastM3: 10_000_000,
    lowerM3: 9_000_000,
    upperM3: 11_000_000,
    subscribersByCell,
    consumptionTypeToTariffType,
    tariffCatalog,
  });

  const konut = priced.find((c) => c.subscriber_type === 'KONUT');
  const noSubs = priced.find((c) => c.subscriber_type === 'NO_SUBS_TYPE');
  assert.strictEqual(noSubs.not_priced_reason, 'no_subscribers');
  assert.ok(noSubs.volume_m3 > 0); // real volume, just unpriced

  // Same customer_group for both, so they land in one group row together.
  const customerGroupByKey = new Map([
    [cellKey('Alpha', 'KONUT'), 'Konut'],
    [cellKey('Beta', 'NO_SUBS_TYPE'), 'Konut'],
  ]);

  const groups = buildGroupBreakdown(priced, customerGroupByKey);
  const konutGroup = groups.find((g) => g.customer_group === 'Konut');

  const totalVolume = konut.volume_m3 + noSubs.volume_m3;
  const pricedVolume = konut.volume_m3; // noSubs contributes 0 money and must be excluded from the denominator

  const naiveAverage = round2(konutGroup.total_try / totalVolume);
  const correctAverage = round2(konutGroup.total_try / pricedVolume);

  assert.strictEqual(konutGroup.not_priced_volume_m3, noSubs.volume_m3);
  assert.strictEqual(konutGroup.average_price_per_m3, correctAverage);
  assert.notStrictEqual(konutGroup.average_price_per_m3, naiveAverage);
});
