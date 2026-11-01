// Pure functions for Module 5b (Revenue Scenarios) — "what happens to
// revenue if prices change?" No database access here; backend/app.js
// loads the same consumption/tariff/subscriber data GET /api/revenue
// already loads and hands this module the baseline per-cell breakdown
// (from revenue.js's buildRevenueBreakdown) plus a scenario description.
//
// The only genuinely new math here is (1) scaling a tariff catalog's
// band prices by a scenario's price change, and (2) a constant-elasticity
// demand-response step. Everything else (tiered-band pricing, summing
// fields, rounding) reuses revenue.js's own functions rather than
// re-implementing them.

const { priceThroughBands, round2, sumField, cellKey } = require('./revenue');

const HOUSING_TYPE = 'KONUT ABONELERİ';
const WORKPLACE_TYPE = 'İŞYERİ ABONELERİ';
// "Housing" for demand-response SCOPE means the Konut customer_group (the
// same grouping Revenue Estimate's customer-group table uses) — not the
// KONUT ABONELERİ tariff type, which only decides whose BANDS change in
// per-step mode. A customer_group and a tariff_type are different axes of
// the same cell, so scoping by the wrong one would include/exclude the
// wrong set of cells whenever they don't line up one-to-one.
const HOUSING_CUSTOMER_GROUP = 'Konut';
const MIN_PCT = -50;
const MAX_PCT = 100;
const MIN_ELASTICITY = -1;
const MAX_ELASTICITY = 0;
const MAX_SCENARIOS = 2;

// The May 2025 İzmir tariff change, expressed as per-band % increases on
// top of the July 2024 prices this app otherwise uses — the frontend's
// preset button fills this in. The January 2025 increase is deliberately
// excluded: sources disagree on its size (26% vs 30%).
const MAY_2025_PRESET_STEPS = { housing: [0, 15, 25, 35], workplace: [0, 15, 25, 35] };

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function validatePct(value, fieldPath, errors) {
  const n = Number(value);
  if (!isFiniteNumber(n)) {
    errors[fieldPath] = 'Enter a number.';
    return null;
  }
  if (n < MIN_PCT || n > MAX_PCT) {
    errors[fieldPath] = `Must be between ${MIN_PCT} and ${MAX_PCT}.`;
    return null;
  }
  return n;
}

// Validates a POST /api/revenue/scenario request body. Returns
// { valid: true, scenarios } or { valid: false, errors } (field path ->
// message, matching this codebase's { error, fields } 400 shape).
function validateScenarioRequest(body) {
  const errors = {};
  const input = body && Array.isArray(body.scenarios) ? body.scenarios : null;

  if (!input || input.length === 0) {
    return { valid: false, errors: { scenarios: 'Provide at least one scenario.' } };
  }
  if (input.length > MAX_SCENARIOS) {
    return { valid: false, errors: { scenarios: `At most ${MAX_SCENARIOS} scenarios are supported.` } };
  }

  const scenarios = input.map((raw, i) => {
    const prefix = `scenarios[${i}]`;
    const fallbackName = i === 0 ? 'Scenario A' : 'Scenario B';
    const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 60) : fallbackName;

    const mode = raw?.mode;
    if (mode !== 'uniform' && mode !== 'per_step') {
      errors[`${prefix}.mode`] = 'mode must be "uniform" or "per_step".';
      return null;
    }

    let uniform_pct = null;
    let steps = null;
    let note = null;

    if (mode === 'uniform') {
      if (raw.uniform_pct === undefined || raw.uniform_pct === null) {
        errors[`${prefix}.uniform_pct`] = 'uniform_pct is required for uniform mode.';
        return null;
      }
      uniform_pct = validatePct(raw.uniform_pct, `${prefix}.uniform_pct`, errors);
      if (uniform_pct === null) return null;
    } else {
      const h = raw?.steps?.housing;
      const w = raw?.steps?.workplace;
      if (!Array.isArray(h) || h.length !== 4 || !Array.isArray(w) || w.length !== 4) {
        errors[`${prefix}.steps`] = 'per_step mode requires steps.housing and steps.workplace, each with exactly 4 values.';
        return null;
      }
      const housing = h.map((v, bi) => validatePct(v, `${prefix}.steps.housing[${bi}]`, errors));
      const workplace = w.map((v, bi) => validatePct(v, `${prefix}.steps.workplace[${bi}]`, errors));
      if (housing.some((v) => v === null) || workplace.some((v) => v === null)) return null;
      steps = { housing, workplace };
      note = 'Only housing (KONUT ABONELERİ) and workplace (İŞYERİ ABONELERİ) bands were changed; every other tariff type is unchanged.';
    }

    let elasticity = raw.elasticity === undefined || raw.elasticity === null ? 0 : Number(raw.elasticity);
    if (!isFiniteNumber(elasticity) || elasticity < MIN_ELASTICITY || elasticity > MAX_ELASTICITY) {
      errors[`${prefix}.elasticity`] = `elasticity must be between ${MIN_ELASTICITY} and ${MAX_ELASTICITY}.`;
      return null;
    }

    const elasticity_scope = raw.elasticity_scope === 'all' ? 'all' : 'housing';

    return { name, mode, uniform_pct, steps, elasticity, elasticity_scope, note };
  });

  if (Object.keys(errors).length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, scenarios };
}

// Builds a scenario's tariff catalog from the baseline one (as returned
// by revenue.js's buildTariffCatalog): every band price scaled by the
// scenario's % change, at full precision (never rounded here — rounding
// happens once, at the final money totals, same as revenue.js itself).
function scaleTariffCatalog(tariffCatalog, scenario) {
  const scaled = new Map();

  tariffCatalog.forEach((entry, tariffType) => {
    if (scenario.mode === 'uniform') {
      const factor = 1 + scenario.uniform_pct / 100;
      scaled.set(tariffType, {
        ambiguous: entry.ambiguous,
        bands: entry.bands.map((b) => ({
          ...b,
          waterPrice: b.waterPrice == null ? null : b.waterPrice * factor,
          wastewaterPrice: b.wastewaterPrice == null ? null : b.wastewaterPrice * factor,
        })),
      });
      return;
    }

    // per_step: only the housing/workplace bands change; every other
    // tariff type is carried over completely unchanged (same object).
    if (tariffType === HOUSING_TYPE || tariffType === WORKPLACE_TYPE) {
      const steps = tariffType === HOUSING_TYPE ? scenario.steps.housing : scenario.steps.workplace;
      scaled.set(tariffType, {
        ambiguous: entry.ambiguous,
        bands: entry.bands.map((b, i) => {
          const factor = 1 + (steps[i] ?? 0) / 100;
          return {
            ...b,
            waterPrice: b.waterPrice == null ? null : b.waterPrice * factor,
            wastewaterPrice: b.wastewaterPrice == null ? null : b.wastewaterPrice * factor,
          };
        }),
      });
    } else {
      scaled.set(tariffType, entry);
    }
  });

  return scaled;
}

// Re-prices one baseline (already-priced) cell under a scenario's bands,
// with constant-elasticity demand response:
//   1. r = scenario bill at the baseline average use / baseline bill at
//      the baseline average use — the price ratio a subscriber actually
//      faces under the new tariff, at their current usage level.
//   2. new volume = baseline volume * r^elasticity (0 outside the
//      elasticity's scope, so volume is unchanged there).
//   3. the NEW average use is re-priced through the scenario's bands —
//      elasticity changes which bands apply, so this re-runs the tiered
//      pricing rather than just scaling baseline revenue by r^elasticity.
function rescoreCell(baselineCell, scenarioBands, elasticity, inScope) {
  if (baselineCell.not_priced_reason || !baselineCell.subscribers || !scenarioBands) {
    return { ...baselineCell };
  }

  const subscribers = baselineCell.subscribers;
  const baselineAvgUse = baselineCell.avg_use_m3;
  const baselineBillAtBaselineUse = baselineCell.total.mid;

  const scenarioWaterAtBaselineUse = priceThroughBands(baselineAvgUse, scenarioBands, 'waterPrice') * subscribers;
  const scenarioWastewaterAtBaselineUse = priceThroughBands(baselineAvgUse, scenarioBands, 'wastewaterPrice') * subscribers;
  const scenarioBillAtBaselineUse = scenarioWaterAtBaselineUse + scenarioWastewaterAtBaselineUse;

  const priceRatio = baselineBillAtBaselineUse > 0 ? scenarioBillAtBaselineUse / baselineBillAtBaselineUse : 1;
  const effectiveElasticity = inScope ? elasticity : 0;
  const volumeRatio = Math.pow(priceRatio, effectiveElasticity);

  const newVolumeMid = baselineCell.volume_m3 * volumeRatio;
  const newVolumeLow = baselineCell.lower_m3 * volumeRatio;
  const newVolumeHigh = baselineCell.upper_m3 * volumeRatio;

  const priceOne = (volumeM3, field) => {
    const avgUse = volumeM3 / subscribers;
    return priceThroughBands(avgUse, scenarioBands, field) * subscribers;
  };

  const water = {
    mid: round2(priceOne(newVolumeMid, 'waterPrice')),
    low: round2(priceOne(newVolumeLow, 'waterPrice')),
    high: round2(priceOne(newVolumeHigh, 'waterPrice')),
  };
  const wastewater = {
    mid: round2(priceOne(newVolumeMid, 'wastewaterPrice')),
    low: round2(priceOne(newVolumeLow, 'wastewaterPrice')),
    high: round2(priceOne(newVolumeHigh, 'wastewaterPrice')),
  };

  return {
    district: baselineCell.district,
    subscriber_type: baselineCell.subscriber_type,
    subscribers,
    volume_m3: newVolumeMid,
    lower_m3: newVolumeLow,
    upper_m3: newVolumeHigh,
    avg_use_m3: newVolumeMid / subscribers,
    price_ratio: priceRatio,
    water,
    wastewater,
    total: {
      mid: round2(water.mid + wastewater.mid),
      low: round2(water.low + wastewater.low),
      high: round2(water.high + wastewater.high),
    },
    not_priced_reason: null,
  };
}

// Applies one scenario to one month's baseline cells (as returned by
// revenue.js's buildRevenueBreakdown: { cells, totals }). The not-priced
// volume/% are carried over unchanged from the baseline — a price-only or
// demand-response change never changes which cells are priceable, only
// what the already-priceable ones are worth.
function buildScenarioMonth({
  baselineCells,
  baselineTotals,
  tariffCatalog,
  consumptionTypeToTariffType,
  customerGroupByKey,
  scenario,
}) {
  const scenarioCatalog = scaleTariffCatalog(tariffCatalog, scenario);

  const cells = baselineCells.map((c) => {
    const tariffType = consumptionTypeToTariffType.get(c.subscriber_type) || null;
    const scenarioBands = tariffType ? scenarioCatalog.get(tariffType)?.bands || null : null;
    const customerGroup = customerGroupByKey.get(cellKey(c.district, c.subscriber_type)) || null;
    const inScope = scenario.elasticity_scope === 'all' || customerGroup === HOUSING_CUSTOMER_GROUP;
    return rescoreCell(c, scenarioBands, scenario.elasticity, inScope);
  });

  const volume_m3 = cells.reduce((sum, c) => sum + c.volume_m3, 0);

  const totals = {
    water: sumField(cells, 'water'),
    wastewater: sumField(cells, 'wastewater'),
    total: sumField(cells, 'total'),
    volume_m3,
    not_priced_volume_m3: baselineTotals.not_priced_volume_m3,
    not_priced_pct: baselineTotals.not_priced_pct,
  };

  return { cells, totals };
}

module.exports = {
  HOUSING_TYPE,
  WORKPLACE_TYPE,
  HOUSING_CUSTOMER_GROUP,
  MAY_2025_PRESET_STEPS,
  validateScenarioRequest,
  scaleTariffCatalog,
  rescoreCell,
  buildScenarioMonth,
};
