// Date-only strings from the API are "YYYY-MM-DD". They are parsed and
// formatted by hand throughout this file instead of via `new Date(str)` /
// `toLocaleDateString`, because the Date constructor treats a date-only
// string as UTC midnight while `toLocaleDateString` renders in the local
// timezone — for timezones behind UTC that silently shows the wrong day.
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseDateOnly(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day };
}

export function formatMonthShort(dateStr) {
  const { year, month } = parseDateOnly(dateStr);
  return `${MONTH_SHORT[month - 1]} ${year}`;
}

// "Sep 24" — used for chart axis ticks on narrow screens, where "Sep 2024"
// doesn't leave enough room between labels.
export function formatMonthShortYY(dateStr) {
  const { year, month } = parseDateOnly(dateStr);
  return `${MONTH_SHORT[month - 1]} ${String(year).slice(-2)}`;
}

export function formatMonthLong(dateStr) {
  const { year, month } = parseDateOnly(dateStr);
  return `${MONTH_LONG[month - 1]} ${year}`;
}

// e.g. a `generated_at` timestamp -> "25 Oct 2026". This IS a real instant
// (not a date-only string), so using Date here is safe.
export function formatPublishedDate(isoString) {
  const d = new Date(isoString);
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

export function monthsBetweenInclusive(startStr, endStr) {
  const a = parseDateOnly(startStr);
  const b = parseDateOnly(endStr);
  return (b.year - a.year) * 12 + (b.month - a.month) + 1;
}

// Shifts a "YYYY-MM-DD" string by `offset` whole months (negative = earlier).
export function shiftMonths(dateStr, offset) {
  const { year, month, day } = parseDateOnly(dateStr);
  const total = year * 12 + (month - 1) + offset;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12) + 1;
  return `${newYear}-${String(newMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function fmtInt(value) {
  return Math.round(value).toLocaleString('en-US');
}

export function fmtMillions(value, decimals = 1) {
  return (value / 1_000_000).toFixed(decimals);
}

export function getInitials(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// The one place a "X% higher/lower" change is rounded, so the summary
// sentence and the KPI card always agree on the same figure.
export function fmtPercentChange(pct) {
  return Math.abs(pct).toFixed(1);
}
