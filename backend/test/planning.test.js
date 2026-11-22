const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateNormalM3,
  calculateSafeM3,
  daysInMonth,
  calculateDaysOfCover,
  validatePlanRequest,
  validateStockAmount,
  validateChangeReason,
  largeChangePct,
  isPositiveWholeNumber,
  MAX_STOCK_M3,
} = require('../planning');

test('calculateNormalM3: Sep 2024 forecast 25.4M -> normal ~= 37.6M with loss 0.324', () => {
  const normal = calculateNormalM3(25_400_000, 0.324);
  // Rounded to 1 decimal place in millions, same as the UI displays it.
  assert.strictEqual(Math.round(normal / 100_000) / 10, 37.6);
});

test('calculateSafeM3: upper-bound forecast scaled the same way as normal', () => {
  const safe = calculateSafeM3(26_500_000, 0.324);
  assert.strictEqual(Math.round(safe / 100_000) / 10, 39.2);
});

test('calculateNormalM3 and calculateSafeM3 round to the nearest whole m3', () => {
  assert.strictEqual(calculateNormalM3(1000, 0.5), 2000);
  assert.strictEqual(calculateSafeM3(1001, 0.5), 2002);
});

test('daysInMonth handles leap years and short months', () => {
  assert.strictEqual(daysInMonth(2024, 2), 29); // leap year
  assert.strictEqual(daysInMonth(2023, 2), 28); // not a leap year
  assert.strictEqual(daysInMonth(2024, 9), 30); // September
  assert.strictEqual(daysInMonth(2024, 1), 31); // January
});

test('calculateDaysOfCover rounds down to a whole day', () => {
  // dailyRate = 300,000 / 30 = 10,000 m3/day; 305,000 / 10,000 = 30.5 -> 30
  assert.strictEqual(calculateDaysOfCover(305_000, 300_000, 30), 30);
  // Exact division still works.
  assert.strictEqual(calculateDaysOfCover(300_000, 300_000, 30), 30);
});

test('calculateDaysOfCover returns null when it cannot be computed', () => {
  assert.strictEqual(calculateDaysOfCover(null, 300_000, 30), null);
  assert.strictEqual(calculateDaysOfCover(300_000, null, 30), null);
  assert.strictEqual(calculateDaysOfCover(300_000, 0, 30), null);
  assert.strictEqual(calculateDaysOfCover(300_000, -5, 30), null);
  assert.strictEqual(calculateDaysOfCover(300_000, 300_000, 0), null);
});

test('isPositiveWholeNumber', () => {
  assert.strictEqual(isPositiveWholeNumber(5), true);
  assert.strictEqual(isPositiveWholeNumber(0), false);
  assert.strictEqual(isPositiveWholeNumber(-5), false);
  assert.strictEqual(isPositiveWholeNumber(5.5), false);
  assert.strictEqual(isPositiveWholeNumber('5'), false);
  assert.strictEqual(isPositiveWholeNumber(null), false);
  assert.strictEqual(isPositiveWholeNumber(NaN), false);
  assert.strictEqual(isPositiveWholeNumber(Infinity), false);
});

test('isPositiveWholeNumber rejects values outside the safe integer range', () => {
  assert.strictEqual(isPositiveWholeNumber(Number.MAX_SAFE_INTEGER), true);
  assert.strictEqual(isPositiveWholeNumber(Number.MAX_SAFE_INTEGER + 1), false);
  assert.strictEqual(isPositiveWholeNumber(2 ** 53), false);
});

test('validateStockAmount: valid amounts, no capacity given (falls back to MAX_STOCK_M3)', () => {
  assert.strictEqual(validateStockAmount(1), null);
  assert.strictEqual(validateStockAmount(62_000_000), null);
  assert.strictEqual(validateStockAmount(MAX_STOCK_M3), null); // the cap itself is allowed
  assert.strictEqual(validateStockAmount(1, null), null);
});

test('validateStockAmount: not a positive whole number', () => {
  assert.strictEqual(validateStockAmount(0), 'Enter a positive amount in m³');
  assert.strictEqual(validateStockAmount(-5), 'Enter a positive amount in m³');
  assert.strictEqual(validateStockAmount(1.5), 'Enter a positive amount in m³');
  assert.strictEqual(validateStockAmount('1000'), 'Enter a positive amount in m³');
});

test('validateStockAmount: over the MAX_STOCK_M3 cap when no real capacity is given', () => {
  assert.strictEqual(
    validateStockAmount(MAX_STOCK_M3 + 1),
    'This is more than the total usable storage capacity (10,000.0M m³). Check the number.'
  );
  assert.strictEqual(
    validateStockAmount(999_999_999_999),
    'This is more than the total usable storage capacity (10,000.0M m³). Check the number.'
  );
});

test('validateStockAmount: at and above a real storage capacity', () => {
  const capacityM3 = 776_422_000;
  assert.strictEqual(validateStockAmount(capacityM3, capacityM3), null); // exactly at capacity is allowed
  assert.strictEqual(
    validateStockAmount(capacityM3 + 1, capacityM3),
    'This is more than the total usable storage capacity (776.4M m³). Check the number.'
  );
});

test('validateStockAmount: a null/zero capacity falls back to MAX_STOCK_M3, not to rejecting everything', () => {
  assert.strictEqual(validateStockAmount(62_000_000, null), null);
  assert.strictEqual(validateStockAmount(62_000_000, 0), null);
});

test('validateChangeReason: 5-300 characters after trimming is valid', () => {
  assert.strictEqual(validateChangeReason('Meter misread.'), null);
  assert.strictEqual(validateChangeReason('  Meter misread.  '), null);
  assert.strictEqual(validateChangeReason('x'.repeat(300)), null);
});

test('validateChangeReason: under 5 characters (after trimming) is rejected', () => {
  assert.strictEqual(validateChangeReason('abcd'), 'Enter a reason (5-300 characters).');
  assert.strictEqual(validateChangeReason('    abcd    '), 'Enter a reason (5-300 characters).');
  assert.strictEqual(validateChangeReason(''), 'Enter a reason (5-300 characters).');
  assert.strictEqual(validateChangeReason(undefined), 'Enter a reason (5-300 characters).');
});

test('validateChangeReason: over 300 characters is rejected', () => {
  assert.strictEqual(validateChangeReason('x'.repeat(301)), 'Enter a reason (5-300 characters).');
});

test('validateChangeReason: exactly 5 and exactly 300 characters are both valid (boundary)', () => {
  assert.strictEqual(validateChangeReason('x'.repeat(5)), null);
  assert.strictEqual(validateChangeReason('x'.repeat(300)), null);
});

test('largeChangePct: positive and negative percentage change', () => {
  assert.strictEqual(largeChangePct(125_000, 100_000), 25);
  assert.strictEqual(largeChangePct(75_000, 100_000), -25);
  assert.strictEqual(largeChangePct(100_000, 100_000), 0);
});

test('largeChangePct: the 25% boundary itself is not "more than 25%"', () => {
  // Exactly 25% change: a caller comparing Math.abs(pct) > 25 must not flag this.
  const pct = largeChangePct(125_000, 100_000);
  assert.strictEqual(Math.abs(pct) > 25, false);
});

test('largeChangePct: just over the 25% boundary is "more than 25%"', () => {
  const pct = largeChangePct(125_001, 100_000);
  assert.strictEqual(Math.abs(pct) > 25, true);
});

test('largeChangePct: null when there is no previous reading to compare against', () => {
  assert.strictEqual(largeChangePct(100_000, null), null);
  assert.strictEqual(largeChangePct(100_000, 0), null);
  assert.strictEqual(largeChangePct(100_000, undefined), null);
});

test('validatePlanRequest: valid normal plan', () => {
  const { valid, errors } = validatePlanRequest({ plan_type: 'normal', safe_m3: 1_000_000 });
  assert.strictEqual(valid, true);
  assert.deepStrictEqual(errors, {});
});

test('validatePlanRequest: valid safe plan with an optional note', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'safe',
    note: 'Routine safe plan.',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, true);
  assert.deepStrictEqual(errors, {});
});

test('validatePlanRequest: normal/safe ignore custom_m3 and reason even if garbage', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'normal',
    custom_m3: -1,
    reason: 'not_a_real_code',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, true);
  assert.deepStrictEqual(errors, {});
});

test('validatePlanRequest: normal/safe note over 500 characters is rejected', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'normal',
    note: 'x'.repeat(501),
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, false);
  assert.strictEqual(errors.note, 'The note can be at most 500 characters');
});

test('validatePlanRequest: valid custom plan', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: 2_000_000,
    reason: 'planned_maintenance',
    note: 'Treatment plant maintenance 10-20 Nov.',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, true);
  assert.deepStrictEqual(errors, {});
});

test('validatePlanRequest: custom plan missing reason', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: 2_000_000,
    note: 'Some note.',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, false);
  assert.strictEqual(errors.reason, 'Choose a reason');
});

test('validatePlanRequest: custom plan with an unknown reason code', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: 2_000_000,
    reason: 'because_i_said_so',
    note: 'Some note.',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, false);
  assert.strictEqual(errors.reason, 'Choose a reason');
});

test('validatePlanRequest: custom plan missing note', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: 2_000_000,
    reason: 'other',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, false);
  assert.strictEqual(errors.note, 'Add a short note (up to 500 characters)');
});

test('validatePlanRequest: custom plan with a blank (whitespace-only) note', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: 2_000_000,
    reason: 'other',
    note: '     ',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, false);
  assert.strictEqual(errors.note, 'Add a short note (up to 500 characters)');
});

test('validatePlanRequest: custom plan note over 500 characters', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: 2_000_000,
    reason: 'other',
    note: 'x'.repeat(501),
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, false);
  assert.strictEqual(errors.note, 'The note can be at most 500 characters');
});

test('validatePlanRequest: custom_m3 not a positive whole number', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: -100,
    reason: 'other',
    note: 'Some note.',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, false);
  assert.strictEqual(errors.custom_m3, 'Enter a positive amount in m³');
});

test('validatePlanRequest: custom_m3 exceeding 3x the safe amount', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: 94_800_001,
    reason: 'other',
    note: 'Some note.',
    safe_m3: 31_600_000,
  });
  assert.strictEqual(valid, false);
  // Thousands separators, e.g. "94,800,000", not "94800000".
  assert.strictEqual(errors.custom_m3, "The amount can't be more than 3 × the safe plan (94,800,000 m³)");
});

test('validatePlanRequest: custom_m3 exactly 3x the safe amount is allowed', () => {
  const { valid, errors } = validatePlanRequest({
    plan_type: 'custom',
    custom_m3: 3_000_000,
    reason: 'other',
    note: 'Some note.',
    safe_m3: 1_000_000,
  });
  assert.strictEqual(valid, true);
  assert.deepStrictEqual(errors, {});
});

test('validatePlanRequest: unknown plan_type', () => {
  const { valid, errors } = validatePlanRequest({ plan_type: 'bogus', safe_m3: 1_000_000 });
  assert.strictEqual(valid, false);
  assert.ok(errors.plan_type);
});
