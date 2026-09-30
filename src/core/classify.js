// Decide what kind of activity a bank transaction is. Amount convention used
// everywhere: positive = money out / a charge, negative = money in / a credit.

const PAYMENT_RE =
  /\b(payment thank you|thank you for your payment|payment - thank|autopay|auto[- ]pay|automatic payment|payment received|online payment|mobile payment|web payment|e-?payment|epay|ach payment|pymt|card payment)\b/i;
const INTEREST_RE =
  /\b(interest charge|interest charged|purchase interest|interest on purchases|cash advance interest|finance charge|interest adjustment)\b/i;
const FEE_RE =
  /\b(annual (membership )?fee|membership fee|late (payment )?fee|foreign (transaction |exchange |trans )?fee|cash advance fee|balance transfer fee|returned payment fee|over ?limit fee)\b/i;
const REWARD_RE =
  /\b(redemption|redeemed|rewards?|points|cash ?back|pay yourself back|ultimate rewards)\b/i;

/** @typedef {'purchase'|'refund'|'payment'|'fee'|'interest'|'reward'|'deposit'|'withdrawal'} TxnKind */

/**
 * @param {{
 *   accountKind: string,
 *   amountCents: number,
 *   description?: string|null,
 *   rawDescription?: string|null,
 *   categoryDetail?: string|null,
 *   bankType?: string|null,
 * }} t
 * @returns {TxnKind}
 */
export function classify(t) {
  const text = `${t.description ?? ''} ${t.rawDescription ?? ''}`;
  const detail = (t.categoryDetail ?? '').toUpperCase();
  const bankType = (t.bankType ?? '').toLowerCase();

  if (t.accountKind !== 'credit') return t.amountCents < 0 ? 'deposit' : 'withdrawal';

  if (t.amountCents < 0) {
    const looksLikePayment =
      bankType === 'payment' ||
      detail.startsWith('LOAN_PAYMENTS') ||
      PAYMENT_RE.test(text) ||
      (detail.startsWith('TRANSFER_IN') && /payment|transfer/i.test(text));
    if (looksLikePayment) return 'payment';
  }
  if (INTEREST_RE.test(text) || detail.includes('INTEREST_CHARGE')) return 'interest';
  if (bankType === 'fee' || FEE_RE.test(text) || detail.startsWith('BANK_FEES')) return 'fee';
  if (t.amountCents < 0) return REWARD_RE.test(text) ? 'reward' : 'refund';
  return 'purchase';
}

/** Turn "FOOD_AND_DRINK" into "Food & Drink". */
export function prettyCategory(code) {
  if (!code) return null;
  if (!/^[A-Z0-9_]+$/.test(code)) return code;
  return code
    .toLowerCase()
    .split('_')
    .map((w) => (w === 'and' ? '&' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
