// Money is always handled as integer cents. Never do arithmetic on floats.

/**
 * Parse a user- or bank-supplied amount into integer cents.
 * Accepts numbers and strings like "1,234.56", "$12", "-3.5", "(45.00)", "+7".
 * Returns null when the input is empty or not a number.
 * @param {string|number|null|undefined} input
 * @returns {number|null}
 */
export function parseMoney(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  let s = String(input).trim();
  if (!s) return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1).trim();
  }
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  s = s.replace(/^\$/, '').replace(/[,\s]/g, '');
  if (s.startsWith('-')) {
    // "$-12.00"
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const [intPart, fracRaw = ''] = s.split('.');
  const frac = (fracRaw + '000').slice(0, 3);
  let cents = Number(intPart || '0') * 100 + Number(frac.slice(0, 2));
  // Round half away from zero on the third decimal.
  if (Number(frac[2]) >= 5) cents += 1;
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}

/**
 * "$1,234.56" / "-$12.00"
 * @param {number|null|undefined} cents
 */
export function formatMoney(cents) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  const rest = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}$${dollars}.${rest}`;
}

/**
 * Plain decimal string for spreadsheets/CSV: "1234.56", "-12.00".
 * @param {number|null|undefined} cents
 */
export function centsToDecimal(cents) {
  if (cents === null || cents === undefined) return '';
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** @param {Iterable<number>} values */
export function sumCents(values) {
  let total = 0;
  for (const v of values) total += v || 0;
  return total;
}
