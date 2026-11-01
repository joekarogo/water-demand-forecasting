import { formatPublishedDate, formatDateTime, fmtTRYMillions } from './format';

describe('formatPublishedDate', () => {
  test('formats a full ISO-8601 timestamp (TIMESTAMPTZ) as "D Mon YYYY"', () => {
    expect(formatPublishedDate('2026-10-25T20:26:00.000Z')).toBe('25 Oct 2026');
  });

  test('formats an ISO timestamp with a numeric offset the same way', () => {
    expect(formatPublishedDate('2026-10-25T20:26:00.000+03:00')).toBe('25 Oct 2026');
  });
});

describe('formatDateTime', () => {
  test('formats a full ISO-8601 timestamp with a time component', () => {
    expect(formatDateTime('2026-10-30T09:00:00.000Z')).toMatch(/^30 Oct 2026, \d{2}:\d{2}$/);
  });
});

describe('fmtTRYMillions', () => {
  test('stays in millions just below the ₺1B threshold', () => {
    expect(fmtTRYMillions(999_000_000)).toBe('₺999.0M');
  });

  test('switches to billions with two decimals at/above ₺1B', () => {
    expect(fmtTRYMillions(1_000_000_000)).toBe('₺1.00B');
    expect(fmtTRYMillions(10_840_000_000)).toBe('₺10.84B');
  });
});
