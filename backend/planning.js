// Pure functions for Module 3 (Production Planning) — no database access,
// so these can be unit-tested directly (see test/planning.test.js).

const REASON_CODES = [
  'planned_maintenance',
  'drought_restrictions',
  'expected_event',
  'supply_constraint',
  'other',
];

const PLAN_TYPES = ['normal', 'safe', 'custom'];

// Above this, a stock reading is almost certainly a data-entry mistake
// (e.g. an extra digit) rather than a real amount.
const MAX_STOCK_M3 = 10_000_000_000;

function isPositiveWholeNumber(value) {
  // Number.isSafeInteger also rejects NaN/Infinity and non-integers, so it
  // covers what Number.isFinite + Number.isInteger used to check, plus
  // ruling out values that have already lost precision as a JS number.
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

// Field-level message for a stock amount, or null if it's valid.
function validateStockAmount(value) {
  if (!isPositiveWholeNumber(value)) {
    return 'Enter a positive amount in m³';
  }
  if (value > MAX_STOCK_M3) {
    return 'That amount is too large. Check the number.';
  }
  return null;
}

// Normal plan: covers expected demand, scaled up for non-revenue water.
function calculateNormalM3(yhat, lossRate) {
  return Math.round(yhat / (1 - lossRate));
}

// Safe plan: covers demand at the upper end of the forecast's 80% range,
// scaled up for non-revenue water.
function calculateSafeM3(yhatUpper, lossRate) {
  return Math.round(yhatUpper / (1 - lossRate));
}

// Number of days in a given month. month is 1-12 (January = 1), matching
// how months are referred to everywhere else in this API.
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// How many days current stock would last at the chosen plan's production
// rate, rounded down to a whole day. Returns null when it can't be
// computed (no stock, no plan, or a non-positive chosen amount).
function calculateDaysOfCover(stockM3, chosenM3, daysInMonthCount) {
  if (stockM3 == null || !isPositiveWholeNumber(chosenM3) || !daysInMonthCount) {
    return null;
  }
  const dailyRate = chosenM3 / daysInMonthCount;
  return Math.floor(stockM3 / dailyRate);
}

// Validates a POST /api/production/plan request body, returning
// field-level error messages. `safeM3` is the server-computed safe amount
// for the target month (needed to cap a custom amount at 3x it) — never
// trust a safe/normal amount sent by the client.
function validatePlanRequest({ plan_type, custom_m3, reason, note, safe_m3 }) {
  const errors = {};

  if (!PLAN_TYPES.includes(plan_type)) {
    errors.plan_type = `plan_type must be one of: ${PLAN_TYPES.join(', ')}.`;
    return { valid: false, errors };
  }

  if (plan_type === 'custom') {
    if (!isPositiveWholeNumber(custom_m3)) {
      errors.custom_m3 = 'Enter a positive amount in m³';
    } else if (typeof safe_m3 === 'number' && custom_m3 > safe_m3 * 3) {
      errors.custom_m3 = `The amount can't be more than 3 × the safe plan (${(safe_m3 * 3).toLocaleString('en-US')} m³)`;
    }

    if (!REASON_CODES.includes(reason)) {
      errors.reason = 'Choose a reason';
    }

    const trimmedNote = typeof note === 'string' ? note.trim() : '';
    if (trimmedNote.length < 1) {
      errors.note = 'Add a short note (up to 500 characters)';
    } else if (trimmedNote.length > 500) {
      errors.note = 'The note can be at most 500 characters';
    }
  } else {
    // normal / safe: custom_m3 and reason are ignored outright (the
    // server computes the amount itself); note stays optional, max 500.
    if (note !== undefined && note !== null) {
      const trimmedNote = typeof note === 'string' ? note.trim() : '';
      if (trimmedNote.length > 500) {
        errors.note = 'The note can be at most 500 characters';
      }
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

module.exports = {
  REASON_CODES,
  PLAN_TYPES,
  MAX_STOCK_M3,
  isPositiveWholeNumber,
  validateStockAmount,
  calculateNormalM3,
  calculateSafeM3,
  daysInMonth,
  calculateDaysOfCover,
  validatePlanRequest,
};
