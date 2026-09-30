const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function money(cents, { sign = false } = {}) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '—';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const s = `$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  if (neg) return `-${s}`;
  return sign && cents > 0 ? `+${s}` : s;
}

/** "12.34" -> 1234 cents; returns null when not a number. */
export function parseCents(text) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim().replace(/[$,\s]/g, '');
  if (!s) return null;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const cents = Number(i || '0') * 100 + Number((f + '00').slice(0, 2)) + (Number(f[2] ?? 0) >= 5 ? 1 : 0);
  return neg ? -cents : cents;
}

export function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function parts(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

/** "Sep 14" (adds the year when it differs from `today`) */
export function shortDate(iso, today) {
  if (!iso) return '—';
  const { y, m, d } = parts(iso);
  const sameYear = today ? today.slice(0, 4) === String(y) : true;
  return `${MONTHS[m - 1]} ${d}${sameYear ? '' : `, ${y}`}`;
}

export function longDate(iso) {
  if (!iso) return '—';
  const { y, m, d } = parts(iso);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function period(start, end) {
  const a = parts(start);
  const b = parts(end);
  return `${MONTHS[a.m - 1]} ${a.d}${a.y !== b.y ? `, ${a.y}` : ''} – ${MONTHS[b.m - 1]} ${b.d}, ${b.y}`;
}

export function daysBetween(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

export function relativeTime(isoTime) {
  if (!isoTime) return 'never';
  const diff = (Date.now() - Date.parse(isoTime)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  const days = Math.round(diff / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const STATUS = {
  open: { label: 'Current cycle', hint: 'Statement not closed yet' },
  nothing: { label: 'Nothing to claim', hint: 'All items excluded' },
  unpaid: { label: 'Not paid yet', hint: 'Statement closed; pay the card, then submit' },
  ready: { label: 'Ready to submit', hint: 'Paid; send the report to your company' },
  submitted: { label: 'Submitted', hint: 'Waiting for reimbursement' },
  partial: { label: 'Partly reimbursed', hint: 'Some money still owed' },
  reimbursed: { label: 'Reimbursed', hint: 'Fully paid back' },
};

export const REASON = {
  default: null,
  included: 'Included by you',
  excluded: 'Personal',
  partial: 'Partly claimed',
  rule: 'Rule',
  fee: 'Card fee',
  reward: 'Rewards',
  payment: 'Card payment',
};

export const ROLE_LABEL = {
  expenses: 'Expense card',
  reimbursements: 'Receives Zelle',
  ignore: 'Ignored',
};

export function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
