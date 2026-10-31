// Pure functions for Module 4 (Demand by District) — no database access
// here; see backend/app.js for the SQL that turns consumption_detail,
// the published forecast and the active production plans into the
// `consumptionRows`/`districts`/forecast numbers these take as input.

// Every distinct calendar year present in `rows` for a given calendar
// month (1-12), most recent first.
function distinctYearsForMonth(rows, month) {
  const years = new Set();
  rows.forEach((r) => {
    if (r.month === month) years.add(r.year);
  });
  return [...years].sort((a, b) => b - a);
}

// The 3 most recent years that actually have data for this calendar
// month — not a fixed offset, since which years qualify shifts depending
// on how far the historical data reaches for that particular month.
// Can return fewer than 3 if the dataset doesn't go back far enough.
function pickShareYears(rows, month) {
  return distinctYearsForMonth(rows, month).slice(0, 3);
}

function totalForYearMonth(rows, year, month) {
  return rows.filter((r) => r.year === year && r.month === month).reduce((sum, r) => sum + r.consumption_m3, 0);
}

// Map<district, share> for one specific (year, month) — each district's
// fraction (0-1) of that month's total consumption across all districts.
function sharesForYearMonth(rows, year, month) {
  const total = totalForYearMonth(rows, year, month);
  const shares = new Map();
  rows
    .filter((r) => r.year === year && r.month === month)
    .forEach((r) => shares.set(r.district, total > 0 ? r.consumption_m3 / total : 0));
  return shares;
}

// Map<district, share> averaged over `years`, for one calendar month.
// A district with no rows at all in a given year counts as a 0 share
// that year, rather than being excluded from the average.
function averageShares(rows, districts, month, years) {
  const perYear = years.map((y) => sharesForYearMonth(rows, y, month));
  const result = new Map();
  districts.forEach((d) => {
    const sum = perYear.reduce((acc, m) => acc + (m.get(d) || 0), 0);
    result.set(d, years.length ? sum / years.length : 0);
  });
  return result;
}

// Every distinct district present in `rows`, alphabetically (for a
// deterministic, reproducible column order).
function listDistricts(rows) {
  return [...new Set(rows.map((r) => r.district))].sort();
}

// Rounds `values` to `decimals` places so they sum to exactly `total`,
// using the largest-remainder (Hamilton) method: every value is floored
// to the display precision first, then the few display units still
// needed to reach `total` are handed out one at a time to whichever
// entries had the largest fractional remainder. This keeps every
// displayed value within one display unit of its true value — unlike
// dumping the whole rounding difference on a single (e.g. the largest)
// entry, which can push that one entry further off than necessary.
// Applied here because shares must sum to 100% and allocations must sum
// to the plan total.
function roundToTotal(values, total, decimals = 0) {
  if (values.length === 0) return [];
  const factor = 10 ** decimals;
  const scaled = values.map((v) => v * factor);
  const floored = scaled.map((v) => Math.floor(v));
  const remainders = scaled.map((v, i) => v - floored[i]);

  const targetUnits = Math.round(total * factor);
  let unitsToDistribute = targetUnits - floored.reduce((a, b) => a + b, 0);

  const order = values.map((_, i) => i).sort((a, b) => remainders[b] - remainders[a]);
  const result = [...floored];
  for (let i = 0; i < order.length && unitsToDistribute > 0; i++, unitsToDistribute--) {
    result[order[i]] += 1;
  }
  return result.map((v) => v / factor);
}

// The full per-district breakdown for one forecast month: shares (summing
// to exactly 100%), forecast/low/high m3 split by share, plan allocation
// (summing to exactly the plan total, or null with no active plan), and
// the share change vs the year before.
function buildDistrictBreakdown({ consumptionRows, districts, calendarMonth, forecastM3, lowerM3, upperM3, planChosenM3 }) {
  const shareYears = pickShareYears(consumptionRows, calendarMonth);
  const avgShare = averageShares(consumptionRows, districts, calendarMonth, shareYears);
  const rawShares = districts.map((d) => avgShare.get(d) || 0);
  const sharePct = roundToTotal(rawShares.map((s) => s * 100), 100, 1);

  let allocation = districts.map(() => null);
  if (planChosenM3 != null) {
    const rawAlloc = rawShares.map((s) => planChosenM3 * s);
    allocation = roundToTotal(rawAlloc, planChosenM3, 0);
  }

  const changeYears = shareYears.length >= 2 ? [shareYears[0], shareYears[1]] : null;
  let shareChangePts = districts.map(() => null);
  if (changeYears) {
    const [yRecent, yBefore] = changeYears;
    const recent = sharesForYearMonth(consumptionRows, yRecent, calendarMonth);
    const before = sharesForYearMonth(consumptionRows, yBefore, calendarMonth);
    shareChangePts = districts.map((d) => ((recent.get(d) || 0) - (before.get(d) || 0)) * 100);
  }

  const rows = districts.map((d, i) => ({
    district: d,
    share_pct: sharePct[i],
    forecast_m3: forecastM3 * rawShares[i],
    lower_m3: lowerM3 * rawShares[i],
    upper_m3: upperM3 * rawShares[i],
    allocation_m3: allocation[i],
    share_change_pts: shareChangePts[i],
  }));

  return { shareYears, changeYears, rows };
}

// Across every calendar month (1-12), the single district whose 3-year
// average share swings the most between its highest and lowest month —
// the ratio, and which months those were. Returns null if there isn't
// enough data to compute a meaningful ratio for any district.
function computeSeasonalSwing(consumptionRows, districts) {
  let best = null;

  districts.forEach((district) => {
    let highShare = -Infinity;
    let lowShare = Infinity;
    let highMonth = null;
    let lowMonth = null;

    for (let month = 1; month <= 12; month++) {
      const years = pickShareYears(consumptionRows, month);
      if (years.length === 0) continue; // no data at all for this calendar month
      const share = averageShares(consumptionRows, districts, month, years).get(district) || 0;
      if (share > highShare) {
        highShare = share;
        highMonth = month;
      }
      if (share < lowShare) {
        lowShare = share;
        lowMonth = month;
      }
    }

    if (highMonth === null || lowShare <= 0) return; // can't form a meaningful ratio
    const ratio = highShare / lowShare;
    if (!best || ratio > best.ratio) {
      best = { district, ratio, highMonth, lowMonth };
    }
  });

  return best;
}

module.exports = {
  distinctYearsForMonth,
  pickShareYears,
  sharesForYearMonth,
  averageShares,
  listDistricts,
  roundToTotal,
  buildDistrictBreakdown,
  computeSeasonalSwing,
};
