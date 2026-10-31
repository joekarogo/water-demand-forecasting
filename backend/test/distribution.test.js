const test = require('node:test');
const assert = require('node:assert/strict');
const {
  pickShareYears,
  listDistricts,
  roundToTotal,
  buildDistrictBreakdown,
  computeSeasonalSwing,
} = require('../distribution');

// Mirrors the real dataset's shape: 2021-2024 have data for Jan-Aug, but
// only 2021-2023 have data for Sep-Dec (2024's Sep-Dec hasn't happened
// yet in the source data) — so picking "the 3 most recent years with
// data" genuinely depends on the calendar month, not a fixed offset.
function buildRows({ districtTotals, months = [1, 9] }) {
  const rows = [];
  const yearsByMonth = { 1: [2021, 2022, 2023, 2024], 9: [2021, 2022, 2023] };
  months.forEach((month) => {
    yearsByMonth[month].forEach((year) => {
      Object.entries(districtTotals(year, month)).forEach(([district, consumption_m3]) => {
        rows.push({ year, month, district, consumption_m3 });
      });
    });
  });
  return rows;
}

test('pickShareYears: picks the 3 most recent years that actually have data for that calendar month', () => {
  const rows = buildRows({ districtTotals: () => ({ A: 100, B: 100 }) });
  assert.deepStrictEqual(pickShareYears(rows, 1), [2024, 2023, 2022]);
  assert.deepStrictEqual(pickShareYears(rows, 9), [2023, 2022, 2021]);
  assert.deepStrictEqual(pickShareYears(rows, 6), []); // no data seeded for June at all
});

test('roundToTotal: rounded values sum to exactly the target', () => {
  const values = [33.333333, 33.333333, 33.333334]; // sums to 100 before rounding
  const rounded = roundToTotal(values, 100, 1);
  const sum = rounded.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `expected ~100, got ${sum}`);
  // Here the largest-remainder entry happens to be index 2, same result
  // the old "give the diff to the largest value" approach would produce.
  assert.ok(Math.abs(rounded[2] - (100 - rounded[0] - rounded[1])) < 1e-9);
});

test('roundToTotal: largest-remainder method spreads the adjustment fairly instead of distorting one entry, and 9.049 is not pushed to 9.1 unnecessarily', () => {
  // Five districts each truly at 9.049% (remainder .49 of a display
  // unit) plus one at 54.755% (remainder .55) — sums to exactly 100.
  // Independent rounding undershoots by 0.2 display units (3 whole
  // units at decimals=1), which must be distributed somewhere.
  const values = [9.049, 9.049, 9.049, 9.049, 9.049, 54.755];
  const rounded = roundToTotal(values, 100, 1);
  const sum = rounded.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 1e-9, `expected ~100, got ${sum}`);

  // Every displayed value stays within one display unit (0.1) of its
  // true value — the old "dump it all on the largest entry" approach
  // would have rounded the 54.755 entry to 55.0, 0.245 away from the
  // truth (more than one display unit).
  values.forEach((v, i) => {
    assert.ok(Math.abs(rounded[i] - v) <= 0.1 + 1e-9, `index ${i}: ${rounded[i]} vs true ${v}`);
  });
  assert.ok(Math.abs(rounded[5] - 54.8) < 1e-9, `expected the 54.755 entry to round to 54.8, got ${rounded[5]}`);

  // Most of the 9.049 entries round down to 9.0 — the largest remainder
  // only goes to as many entries as there are leftover units, not to
  // every tied entry and not to whichever one happens to be "largest".
  const nineRounded = rounded.slice(0, 5);
  assert.ok(nineRounded.includes(9.0), 'expected at least one 9.049 entry to round down to 9.0');
});

test('roundToTotal: whole-number allocations sum to exactly the plan total', () => {
  const planTotal = 1_000_001; // deliberately not divisible evenly by 3
  const rawShares = [0.333333, 0.333333, 0.333334];
  const allocations = roundToTotal(
    rawShares.map((s) => planTotal * s),
    planTotal,
    0
  );
  assert.strictEqual(allocations.reduce((a, b) => a + b, 0), planTotal);
  allocations.forEach((v) => assert.ok(Number.isInteger(v)));
});

test('buildDistrictBreakdown: shares sum to exactly 100% and allocations sum to exactly the plan total', () => {
  // Uneven totals (301 total, not a clean split across 3 districts) to
  // actually exercise the rounding fix, for both a Jan-style and a
  // Sep-style (fewer available years) calendar month.
  const rows = buildRows({
    districtTotals: () => ({ A: 100, B: 100, C: 101 }),
    months: [1, 9],
  });
  const districts = listDistricts(rows);

  for (const calendarMonth of [1, 9]) {
    const { rows: districtRows } = buildDistrictBreakdown({
      consumptionRows: rows,
      districts,
      calendarMonth,
      forecastM3: 20_000_000,
      lowerM3: 18_000_000,
      upperM3: 22_000_000,
      planChosenM3: 30_000_001,
    });

    const shareSum = districtRows.reduce((a, d) => a + d.share_pct, 0);
    assert.ok(Math.abs(shareSum - 100) < 1e-9, `month ${calendarMonth}: share sum was ${shareSum}`);

    const allocSum = districtRows.reduce((a, d) => a + d.allocation_m3, 0);
    assert.strictEqual(allocSum, 30_000_001);
  }
});

test('buildDistrictBreakdown: allocation is null for every district when there is no active plan', () => {
  const rows = buildRows({ districtTotals: () => ({ A: 100, B: 100 }) });
  const districts = listDistricts(rows);
  const { rows: districtRows } = buildDistrictBreakdown({
    consumptionRows: rows,
    districts,
    calendarMonth: 1,
    forecastM3: 1000,
    lowerM3: 900,
    upperM3: 1100,
    planChosenM3: null,
  });
  districtRows.forEach((d) => assert.strictEqual(d.allocation_m3, null));
});

test('buildDistrictBreakdown: share change is positive when a district grew and negative when it shrank', () => {
  // District A grows year over year (2022 -> 2023 -> 2024); District B
  // shrinks by the same amount, so the two changes are mirror images.
  const rows = [
    { year: 2022, month: 1, district: 'A', consumption_m3: 40 },
    { year: 2022, month: 1, district: 'B', consumption_m3: 60 },
    { year: 2023, month: 1, district: 'A', consumption_m3: 45 },
    { year: 2023, month: 1, district: 'B', consumption_m3: 55 },
    { year: 2024, month: 1, district: 'A', consumption_m3: 50 },
    { year: 2024, month: 1, district: 'B', consumption_m3: 50 },
  ];
  const districts = listDistricts(rows);
  const { changeYears, rows: districtRows } = buildDistrictBreakdown({
    consumptionRows: rows,
    districts,
    calendarMonth: 1,
    forecastM3: 1000,
    lowerM3: 900,
    upperM3: 1100,
    planChosenM3: null,
  });

  assert.deepStrictEqual(changeYears, [2024, 2023]); // most recent year vs the year before
  const a = districtRows.find((d) => d.district === 'A');
  const b = districtRows.find((d) => d.district === 'B');
  // 2024 share of A = 50%, 2023 share of A = 45% -> +5 points.
  assert.ok(a.share_change_pts > 0, `expected A's share change to be positive, got ${a.share_change_pts}`);
  assert.ok(Math.abs(a.share_change_pts - 5) < 1e-9);
  assert.ok(b.share_change_pts < 0, `expected B's share change to be negative, got ${b.share_change_pts}`);
  assert.ok(Math.abs(a.share_change_pts + b.share_change_pts) < 1e-9); // mirror images
});

test('computeSeasonalSwing: picks the district with the largest high/low ratio, and the right months', () => {
  // District SWING has a big summer spike (month 7) and a deep winter low
  // (month 1); district FLAT holds a constant share all year. Only one
  // 3-year window (2022-2024) is seeded for every month, for simplicity.
  const rows = [];
  for (let month = 1; month <= 12; month++) {
    for (const year of [2022, 2023, 2024]) {
      // SWING: high in July, low in January; FLAT: always equal split.
      const swingShareOfTotal = month === 7 ? 0.8 : month === 1 ? 0.1 : 0.4;
      const total = 1000;
      const swingAmount = total * swingShareOfTotal;
      rows.push({ year, month, district: 'SWING', consumption_m3: swingAmount });
      rows.push({ year, month, district: 'FLAT', consumption_m3: total - swingAmount });
    }
  }
  const districts = listDistricts(rows);
  const swing = computeSeasonalSwing(rows, districts);
  assert.strictEqual(swing.district, 'SWING');
  assert.strictEqual(swing.highMonth, 7);
  assert.strictEqual(swing.lowMonth, 1);
  // 0.8 / 0.1 = 8x
  assert.ok(Math.abs(swing.ratio - 8) < 1e-9, `expected ratio ~8, got ${swing.ratio}`);
});

test('computeSeasonalSwing: returns null when there are no districts', () => {
  assert.strictEqual(computeSeasonalSwing([], []), null);
});
