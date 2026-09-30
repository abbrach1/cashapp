// Dates are plain "YYYY-MM-DD" strings (calendar dates, no time zone).
// All arithmetic goes through UTC so daylight-saving changes never shift a day.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** @param {unknown} s */
export function isISODate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

/** @param {string} iso */
export function parseISO(iso) {
  const m = ISO_RE.exec(iso);
  if (!m) throw new Error(`Invalid date: ${iso}`);
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** @param {number} y @param {number} m 1-12 @param {number} d */
export function toISO(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** @param {number} y @param {number} m 1-12 */
export function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function toUTC(iso) {
  const { y, m, d } = parseISO(iso);
  return Date.UTC(y, m - 1, d);
}

function fromUTC(ms) {
  const dt = new Date(ms);
  return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/** @param {string} iso @param {number} n */
export function addDays(iso, n) {
  return fromUTC(toUTC(iso) + n * DAY_MS);
}

/** Whole days from a to b (b - a). */
export function diffDays(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
}

/**
 * The date in (year, month) for a given day-of-month, clamped to the month's
 * length (day 31 in September is the 30th).
 */
export function clampedDate(y, m, day) {
  return toISO(y, m, Math.min(day, daysInMonth(y, m)));
}

/** Shift a {y, m} pair by n months. */
export function shiftMonth(y, m, n) {
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

/** "2026-09" */
export function monthKey(iso) {
  return iso.slice(0, 7);
}

export function minDate(...dates) {
  return dates.filter(Boolean).sort()[0] ?? null;
}

export function maxDate(...dates) {
  const list = dates.filter(Boolean).sort();
  return list.length ? list[list.length - 1] : null;
}

/**
 * Today's calendar date in the given IANA time zone.
 * @param {string} [timeZone]
 * @param {Date} [now]
 */
export function todayISO(timeZone = 'America/New_York', now = new Date()) {
  return dateInZone(now, timeZone);
}

/** Calendar date of an instant in a time zone. */
export function dateInZone(date, timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Unix seconds -> calendar date in the bank's time zone. */
export function epochToISODate(seconds, timeZone = 'America/New_York') {
  return dateInZone(new Date(seconds * 1000), timeZone);
}

/** Calendar date -> unix seconds at midnight UTC. */
export function isoToEpoch(iso) {
  return Math.floor(toUTC(iso) / 1000);
}

/**
 * Parse "MM/DD/YYYY" (Chase CSV) or "YYYY-MM-DD" into ISO. Returns null if invalid.
 * @param {string} s
 */
export function parseFlexibleDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (isISODate(t)) return t;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
  if (us) {
    let y = Number(us[3]);
    if (us[3].length === 2) y += 2000;
    const iso = toISO(y, Number(us[1]), Number(us[2]));
    return isISODate(iso) ? iso : null;
  }
  return null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 14, 2026" */
export function formatDateLong(iso) {
  if (!iso) return '';
  const { y, m, d } = parseISO(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "09/14/2026" */
export function formatDateUS(iso) {
  if (!iso) return '';
  const { y, m, d } = parseISO(iso);
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

/** "Aug 15 – Sep 14, 2026" (years shown only when they differ) */
export function formatPeriod(start, end) {
  const a = parseISO(start);
  const b = parseISO(end);
  const left = `${MONTHS[a.m - 1]} ${a.d}${a.y !== b.y ? `, ${a.y}` : ''}`;
  return `${left} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
}
