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

// A calendar month's name on its own (1 = January), with no year — for
// values like a seasonal-swing month that aren't tied to one particular year.
export function monthName(monthNumber) {
  return MONTH_LONG[monthNumber - 1];
}

// e.g. a `generated_at` timestamp -> "25 Oct 2026". This IS a real instant
// (not a date-only string), so using Date here is safe.
export function formatPublishedDate(isoString) {
  const d = new Date(isoString);
  return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

// "YYYY-MM-DD" -> "25 Oct 2026". Date-only, so parsed by hand like the
// month formatters above — never `new Date("YYYY-MM-DD")`.
export function formatDateLong(dateStr) {
  const { year, month, day } = parseDateOnly(dateStr);
  return `${day} ${MONTH_SHORT[month - 1]} ${year}`;
}

// "YYYY-MM-DD" -> "25 Oct" — used for chart axis ticks.
export function formatDateShort(dateStr) {
  const { month, day } = parseDateOnly(dateStr);
  return `${day} ${MONTH_SHORT[month - 1]}`;
}

// A real timestamp (e.g. `created_at`) -> "25 Oct 2026, 14:05". Safe to use
// Date directly here, same reasoning as formatPublishedDate.
export function formatDateTime(isoString) {
  const d = new Date(isoString);
  const date = `${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date}, ${time}`;
}

// Today as "YYYY-MM-DD", for a date input's default value/max. This
// formats a live Date (not parsing a date-only string back), so it isn't
// the timezone pitfall the other helpers here guard against.
export function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

// Full-precision Turkish lira with thousands separators, e.g. "₺1,234,567".
export function fmtTRY(value) {
  return `₺${Math.round(value).toLocaleString('en-US')}`;
}

// For KPI cards, where a full figure would be too wide — "₺12.3M", or
// "₺10.84B" once the total reaches ₺1,000M (₺1 billion) or more, so the
// card never has to show a 4+ digit millions figure.
export function fmtTRYMillions(value, decimals = 1) {
  if (Math.abs(value) >= 1_000_000_000) {
    const billions = (value / 1_000_000_000).toFixed(2);
    return `₺${billions}B`;
  }
  const millions = (value / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `₺${millions}M`;
}

// A per-m³ price, e.g. "₺24.18" — kept to 2 decimals since these are
// small enough that whole-lira rounding would hide the housing/business
// price gap the Average price column exists to show.
export function fmtTRYPerM3(value) {
  return `₺${value.toFixed(2)}`;
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

// Display-only title case for district names, using Turkish locale rules
// so the dotted/dotless I and cedilla characters (e.g. "Karabağlar",
// "Çeşme", "Çiğli") render correctly — plain .toUpperCase()/.toLowerCase()
// get Turkish I/i wrong. Never use this on values sent back to the API or
// used as lookup keys; it's purely how a district name is shown on screen.
export function formatDistrictName(name) {
  if (!name) return name;
  return name
    .toLocaleLowerCase('tr-TR')
    .split(' ')
    .map((word) => (word ? word.charAt(0).toLocaleUpperCase('tr-TR') + word.slice(1) : word))
    .join(' ');
}
