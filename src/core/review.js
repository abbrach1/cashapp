// Going back through card history and deciding what was for work.
//
// A transaction counts as reviewed once you looked at it: you chose business,
// personal or split, a rule decided it, or you confirmed the default. Only
// statements still in play (not sent to the company, not reimbursed) need
// reviewing; older history can still be classified, it just isn't asked for.

import { clampedDate, daysInMonth, parseISO } from '../lib/dates.js';
import { periodContaining } from './bills.js';

/** Statement statuses whose transactions still need a decision. */
export const IN_PLAY_STATUSES = new Set(['open', 'unpaid', 'ready', 'nothing']);

/**
 * @param {any} txn
 * @param {import('./claims.js').ClaimInfo|undefined} claim
 */
export function isReviewed(txn, claim) {
  return Boolean(txn.reviewedAt || txn.override || claim?.reason === 'rule');
}

/**
 * Rough "same merchant" key: "STARBUCKS STORE 11923" and "STARBUCKS STORE 5521"
 * both become "starbucks store".
 */
export function merchantKey(txn) {
  return String(txn.merchant || txn.description || '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 1)
    .slice(0, 3)
    .join(' ');
}

function monthPeriod(date) {
  const { y, m } = parseISO(date);
  return { start: clampedDate(y, m, 1), end: clampedDate(y, m, daysInMonth(y, m)) };
}

/**
 * The statement a card transaction belongs to: its bill, or the period it
 * would fall in when there is no bill (before tracking starts, or while the
 * card has no closing day).
 * @param {any} txn
 * @param {any} account
 * @param {{ txnBill: Map<string, string>, bills: Map<string, any>, trackingStart: string|null }} ledger
 */
export function statementOf(txn, account, ledger) {
  const billId = ledger.txnBill.get(txn.id);
  const bill = billId ? ledger.bills.get(billId) : null;
  if (bill) {
    return { key: bill.id, billId: bill.id, start: bill.start, end: bill.end, bill, inPlay: bill.visible && IN_PLAY_STATUSES.has(bill.status) };
  }
  const p = account?.closingDay ? periodContaining(txn.date, account.closingDay) : monthPeriod(txn.date);
  const tracked = !ledger.trackingStart || p.end >= ledger.trackingStart;
  // With a closing day every tracked transaction has a bill, so this one is
  // from before tracking started.
  return { key: `${txn.accountId}|${p.start}`, billId: null, start: p.start, end: p.end, bill: null, inPlay: tracked && !account?.closingDay };
}

/**
 * Card transactions that can be classified: posted expenses on expense cards.
 * @param {import('../store/model.js').Snapshot} snapshot
 * @param {{ claims: Map<string, any> }} ledger
 */
export function* classifiable(snapshot, ledger) {
  for (const t of snapshot.txns.values()) {
    if (t.pending) continue;
    const claim = ledger.claims.get(t.id);
    if (!claim?.applicable) continue;
    yield { txn: t, claim };
  }
}

/** How many transactions in open statements are reviewed. */
export function reviewProgress(snapshot, ledger) {
  const out = { total: 0, unreviewed: 0, unreviewedClosed: 0 };
  for (const { txn, claim } of classifiable(snapshot, ledger)) {
    const s = statementOf(txn, snapshot.accounts.get(txn.accountId), ledger);
    if (!s.inPlay) continue;
    out.total++;
    if (isReviewed(txn, claim)) continue;
    out.unreviewed++;
    if (s.bill && !s.bill.isOpen) out.unreviewedClosed++;
  }
  return out;
}

