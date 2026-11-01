// Pure functions for Module 5 (Revenue Estimate) — no database access
// here; see backend/app.js for the SQL that turns consumption_detail,
// tariffs, tariff_type_map and the published forecast into the
// consumptionRows/cells/tariff inputs these take.
//
// The volume split below is the same 3-year "average share of the same
// calendar month" rule Module 4 (backend/distribution.js) uses for
// districts, just applied to a finer-grained dimension — a (district,
// subscriber_type) "cell" instead of a district alone. Rather than
// re-implementing that averaging logic, this module feeds
// distribution.js's own pickShareYears/averageShares a synthetic
// `district` field (a cell key combining district + subscriber_type) and
// splits it back apart afterwards.

const { pickShareYears, averageShares, roundToTotal } = require('./distribution');

// Separates the two parts of a cell key. Control character, not a
// delimiter that could plausibly appear inside a real district or
// subscriber_type name, so splitting is unambiguous.
const CELL_SEP = '\u0001';

function cellKey(district, subscriberType) {
  return `${district}${CELL_SEP}${subscriberType}`;
}

function splitCellKey(key) {
  const [district, subscriberType] = key.split(CELL_SEP);
  return { district, subscriberType };
}

// Every distinct (district, subscriber_type) cell present in `rows`,
// alphabetically by district then subscriber_type (deterministic order).
function listCells(rows) {
  const keys = new Set(rows.map((r) => cellKey(r.district, r.subscriber_type)));
  return [...keys].sort().map(splitCellKey);
}

// Re-shapes (district, subscriber_type) consumption rows into the
// {district, year, month, consumption_m3} shape distribution.js's pure
// functions expect, using the combined cell key as the "district".
function asCellRows(rows) {
  return rows.map((r) => ({
    year: r.year,
    month: r.month,
    district: cellKey(r.district, r.subscriber_type),
    consumption_m3: r.consumption_m3,
  }));
}

// Splits one forecast month's city volume (mid/low/high) across every
// cell by its 3-year average share of city consumption in that calendar
// month — identical rule to Module 4's district split, just keyed by
// cell instead of district.
function buildCellVolumes({ consumptionRows, cells, calendarMonth, forecastM3, lowerM3, upperM3 }) {
  const cellRows = asCellRows(consumptionRows);
  const keys = cells.map((c) => cellKey(c.district, c.subscriberType));
  const shareYears = pickShareYears(cellRows, calendarMonth);
  const avgShare = averageShares(cellRows, keys, calendarMonth, shareYears);

  const volumes = cells.map((c, i) => {
    const share = avgShare.get(keys[i]) || 0;
    return {
      district: c.district,
      subscriberType: c.subscriberType,
      share,
      volume_m3: forecastM3 * share,
      lower_m3: lowerM3 * share,
      upper_m3: upperM3 * share,
    };
  });

  return { shareYears, volumes };
}

// Rounds to the nearest currency subunit (2 decimal places) — the one
// place money gets rounded, so a hand-calculated test figure like
// "₺277.61" can be compared with ordinary equality.
function round2(value) {
  return Math.round(value * 100) / 100;
}

// Builds subscriber_type -> { bands, ambiguous } from the tariff rows
// already filtered to one valid_from date. A tariff_type is "ambiguous"
// (can't be reliably priced) if any of its bands has more than one
// distinct water or wastewater price in the source data — mirrors the
// ambiguity check database/load_tariffs.py reports at load time, just
// re-applied here at query time per the comment in that loader.
function buildTariffCatalog(tariffRows) {
  const byType = new Map();
  tariffRows.forEach((row) => {
    if (!byType.has(row.subscriber_type)) byType.set(row.subscriber_type, []);
    byType.get(row.subscriber_type).push(row);
  });

  const catalog = new Map();
  byType.forEach((rows, tariffType) => {
    const byBand = new Map();
    rows.forEach((row) => {
      const bandKey = `${row.band_min_m3}:${row.band_max_m3}`;
      if (!byBand.has(bandKey)) byBand.set(bandKey, []);
      byBand.get(bandKey).push(row);
    });

    let ambiguous = false;
    const bands = [];
    byBand.forEach((bandRows, bandKey) => {
      const waterPrices = new Set(bandRows.map((r) => Number(r.price_per_m3)));
      const wastewaterPrices = new Set(bandRows.map((r) => (r.wastewater_price_per_m3 == null ? null : Number(r.wastewater_price_per_m3))));
      if (waterPrices.size > 1 || wastewaterPrices.size > 1) {
        ambiguous = true;
      }
      const sample = bandRows[0];
      bands.push({
        min: Number(sample.band_min_m3),
        max: sample.band_max_m3 == null ? null : Number(sample.band_max_m3),
        waterPrice: Number(sample.price_per_m3),
        wastewaterPrice: sample.wastewater_price_per_m3 == null ? null : Number(sample.wastewater_price_per_m3),
      });
    });
    bands.sort((a, b) => a.min - b.min);

    catalog.set(tariffType, { bands, ambiguous });
  });

  return catalog;
}

// Prices one average subscriber's monthly usage through tiered bands:
// each band only charges for the m3 that falls inside it (standard
// progressive billing), not whichever band the total lands in.
function priceThroughBands(m3PerSubscriber, bands, priceField) {
  let remaining = m3PerSubscriber;
  let total = 0;
  for (const band of bands) {
    if (remaining <= 0) break;
    const width = band.max == null ? Infinity : band.max - band.min;
    const amountInBand = Math.min(remaining, width);
    const price = band[priceField];
    if (price != null) {
      total += amountInBand * price;
    }
    remaining -= amountInBand;
  }
  return total;
}

// The full per-cell revenue breakdown for one forecast month: volume
// split by share (as buildCellVolumes), subscriber-based tariff pricing,
// and which cells couldn't be priced and why.
//
// consumptionTypeToTariffType: Map<subscriber_type (consumption_detail),
//   tariff_type (tariffs.subscriber_type) | null>
// tariffCatalog: Map<tariff_type, { bands, ambiguous }> (buildTariffCatalog)
// subscribersByCell: Map<"district\u0001subscriberType", subscribers|null>
function buildRevenueBreakdown({
  consumptionRows,
  cells,
  calendarMonth,
  forecastM3,
  lowerM3,
  upperM3,
  subscribersByCell,
  consumptionTypeToTariffType,
  tariffCatalog,
}) {
  const { shareYears, volumes } = buildCellVolumes({
    consumptionRows,
    cells,
    calendarMonth,
    forecastM3,
    lowerM3,
    upperM3,
  });

  const priced = volumes.map((v) => {
    const subscribers = subscribersByCell.get(cellKey(v.district, v.subscriberType)) ?? null;
    const tariffType = consumptionTypeToTariffType.get(v.subscriberType) ?? null;
    const tariff = tariffType ? tariffCatalog.get(tariffType) : null;

    let notPricedReason = null;
    if (!tariffType) {
      notPricedReason = 'unmapped';
    } else if (!tariff || tariff.ambiguous) {
      notPricedReason = 'ambiguous';
    } else if (!subscribers && v.volume_m3 > 0) {
      notPricedReason = 'no_subscribers';
    }

    let water_m3 = { mid: 0, low: 0, high: 0 };
    let wastewater_m3 = { mid: 0, low: 0, high: 0 };
    let avg_use_m3 = null;

    if (!notPricedReason && subscribers) {
      const priceOne = (volumeM3, field) => {
        const avgUse = volumeM3 / subscribers;
        return priceThroughBands(avgUse, tariff.bands, field) * subscribers;
      };
      water_m3 = {
        mid: round2(priceOne(v.volume_m3, 'waterPrice')),
        low: round2(priceOne(v.lower_m3, 'waterPrice')),
        high: round2(priceOne(v.upper_m3, 'waterPrice')),
      };
      wastewater_m3 = {
        mid: round2(priceOne(v.volume_m3, 'wastewaterPrice')),
        low: round2(priceOne(v.lower_m3, 'wastewaterPrice')),
        high: round2(priceOne(v.upper_m3, 'wastewaterPrice')),
      };
      avg_use_m3 = v.volume_m3 / subscribers;
    }

    return {
      district: v.district,
      subscriber_type: v.subscriberType,
      subscribers,
      volume_m3: v.volume_m3,
      lower_m3: v.lower_m3,
      upper_m3: v.upper_m3,
      avg_use_m3,
      water: water_m3,
      wastewater: wastewater_m3,
      total: {
        mid: round2(water_m3.mid + wastewater_m3.mid),
        low: round2(water_m3.low + wastewater_m3.low),
        high: round2(water_m3.high + wastewater_m3.high),
      },
      not_priced_reason: notPricedReason,
    };
  });

  const totalVolume = priced.reduce((sum, c) => sum + c.volume_m3, 0);
  const notPriced = priced.filter((c) => c.not_priced_reason);
  const notPricedVolume = notPriced.reduce((sum, c) => sum + c.volume_m3, 0);

  const totals = {
    water: sumField(priced, 'water'),
    wastewater: sumField(priced, 'wastewater'),
    total: sumField(priced, 'total'),
    not_priced_volume_m3: notPricedVolume,
    not_priced_pct: totalVolume > 0 ? (notPricedVolume / totalVolume) * 100 : 0,
    not_priced_breakdown: summarizeNotPriced(priced),
  };

  return { shareYears, cells: priced, totals };
}

function sumField(cells, field) {
  return {
    mid: cells.reduce((sum, c) => sum + c[field].mid, 0),
    low: cells.reduce((sum, c) => sum + c[field].low, 0),
    high: cells.reduce((sum, c) => sum + c[field].high, 0),
  };
}

// Aggregates priced cells by customer_group — subscribers, volume,
// average use per subscriber (group volume / group subscribers, not an
// average of per-cell averages, so it isn't skewed by cells with few
// subscribers), and each money field. average_price_per_m3 divides by
// PRICED volume only (volume_m3 minus not_priced_volume_m3) — dividing
// by total volume would understate the real average price by diluting
// it with volume that earned no money at all.
// customerGroupByKey: Map<"district\u0001subscriberType", customer_group>
function buildGroupBreakdown(cells, customerGroupByKey) {
  const byGroup = new Map();
  cells.forEach((c) => {
    const group = customerGroupByKey.get(cellKey(c.district, c.subscriber_type)) || 'Unknown';
    if (!byGroup.has(group)) {
      byGroup.set(group, {
        customer_group: group,
        subscribers: 0,
        volume_m3: 0,
        not_priced_volume_m3: 0,
        water: 0,
        wastewater: 0,
        total: 0,
      });
    }
    const g = byGroup.get(group);
    g.subscribers += c.subscribers || 0;
    g.volume_m3 += c.volume_m3;
    if (c.not_priced_reason) {
      g.not_priced_volume_m3 += c.volume_m3;
    }
    g.water += c.water.mid;
    g.wastewater += c.wastewater.mid;
    g.total += c.total.mid;
  });

  return [...byGroup.values()]
    .map((g) => {
      const pricedVolume = g.volume_m3 - g.not_priced_volume_m3;
      return {
        customer_group: g.customer_group,
        subscribers: g.subscribers,
        volume_m3: g.volume_m3,
        not_priced_volume_m3: g.not_priced_volume_m3,
        avg_use_m3: g.subscribers > 0 ? g.volume_m3 / g.subscribers : null,
        water_try: round2(g.water),
        wastewater_try: round2(g.wastewater),
        total_try: round2(g.total),
        average_price_per_m3: pricedVolume > 0 ? round2(g.total / pricedVolume) : null,
      };
    })
    .sort((a, b) => b.total_try - a.total_try);
}

// Same aggregation as buildGroupBreakdown, but keyed by (district,
// customer_group) instead of customer_group alone — this is the detail
// list the frontend exports to CSV, one row per district × group.
function buildDistrictGroupBreakdown(cells, customerGroupByKey) {
  const byKey = new Map();
  cells.forEach((c) => {
    const group = customerGroupByKey.get(cellKey(c.district, c.subscriber_type)) || 'Unknown';
    const key = `${c.district}${CELL_SEP}${group}`;
    if (!byKey.has(key)) {
      byKey.set(key, { district: c.district, customer_group: group, subscribers: 0, volume_m3: 0, water: 0, wastewater: 0, total: 0 });
    }
    const g = byKey.get(key);
    g.subscribers += c.subscribers || 0;
    g.volume_m3 += c.volume_m3;
    g.water += c.water.mid;
    g.wastewater += c.wastewater.mid;
    g.total += c.total.mid;
  });

  return [...byKey.values()]
    .map((g) => ({
      district: g.district,
      customer_group: g.customer_group,
      subscribers: g.subscribers,
      volume_m3: g.volume_m3,
      avg_use_m3: g.subscribers > 0 ? g.volume_m3 / g.subscribers : null,
      water_try: round2(g.water),
      wastewater_try: round2(g.wastewater),
      total_try: round2(g.total),
    }))
    .sort((a, b) => (a.district === b.district ? a.customer_group.localeCompare(b.customer_group) : a.district.localeCompare(b.district)));
}

// Counts and total volume per not-priced reason — feeds the "Not priced"
// KPI card's expandable detail, without the frontend re-deriving it from
// the full per-cell list.
function summarizeNotPriced(cells) {
  const byReason = new Map();
  cells
    .filter((c) => c.not_priced_reason)
    .forEach((c) => {
      if (!byReason.has(c.not_priced_reason)) {
        byReason.set(c.not_priced_reason, { reason: c.not_priced_reason, count: 0, volume_m3: 0 });
      }
      const r = byReason.get(c.not_priced_reason);
      r.count += 1;
      r.volume_m3 += c.volume_m3;
    });
  return [...byReason.values()].sort((a, b) => b.volume_m3 - a.volume_m3);
}

module.exports = {
  cellKey,
  splitCellKey,
  listCells,
  buildCellVolumes,
  round2,
  buildTariffCatalog,
  priceThroughBands,
  buildRevenueBreakdown,
  buildGroupBreakdown,
  buildDistrictGroupBreakdown,
  summarizeNotPriced,
  roundToTotal,
  sumField,
};
