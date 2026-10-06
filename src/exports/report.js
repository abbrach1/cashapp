// Data model shared by every export format.

import { formatDateLong, formatPeriod } from '../lib/dates.js';
import { NotFoundError } from '../core/errors.js';

export const KIND_LABELS = {
  purchase: 'Purchase',
  refund: 'Refund / credit',
  payment: 'Card payment',
  fee: 'Card fee',
  interest: 'Interest',
  reward: 'Rewards credit',
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
};

export const REASON_LABELS = {
  default: 'Claimed',
  included: 'Claimed (included by you)',
  excluded: 'Excluded by you',
  partial: 'Partly claimed',
  rule: 'Excluded by rule',
  fee: 'Card fee/interest (excluded by default)',
  reward: 'Rewards credit (excluded by default)',
};

export const STATUS_LABELS = {
  open: 'Current cycle',
  nothing: 'Nothing to claim',
  unpaid: 'Closed – card not paid yet',
  ready: 'Paid – ready to submit',
  submitted: 'Submitted – awaiting reimbursement',
  partial: 'Partly reimbursed',
  reimbursed: 'Reimbursed',
};

/** Bill status for exports; says when you marked it reimbursed yourself. */
export function billStatusLabel(bill) {
  if (bill.status === 'reimbursed' && bill.settledOn && bill.receivedCents < bill.claimCents) return 'Reimbursed (marked by you)';
  return STATUS_LABELS[bill.status] ?? bill.status;
}

export function accountLabel(account) {
  if (!account) return 'Unknown account';
  const name = account.nickname || account.name;
  return account.mask ? `${name} •••• ${account.mask}` : name;
}

function slug(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * @param {import('../store/model.js').Snapshot} snapshot
 * @param {ReturnType<import('../core/ledger.js').buildLedger>} ledger
 * @param {string} billId
 */
export function billReport(snapshot, ledger, billId) {
  const bill = ledger.bills.get(billId);
  if (!bill) throw new NotFoundError('Bill not found');
  const account = snapshot.accounts.get(bill.accountId);
  const settings = ledger.settings;

  const txns = [...snapshot.txns.values()]
    .filter((t) => ledger.txnBill.get(t.id) === billId && !t.pending && t.kind !== 'payment')
    .sort((a, b) => ((a.authDate ?? a.date) < (b.authDate ?? b.date) ? -1 : (a.authDate ?? a.date) > (b.authDate ?? b.date) ? 1 : a.id < b.id ? -1 : 1));

  const lines = txns.map((t) => {
    const c = ledger.claims.get(t.id);
    return {
      id: t.id,
      date: t.authDate ?? t.date,
      postDate: t.date,
      merchant: t.merchant || t.description,
      description: t.rawDescription && t.rawDescription !== t.merchant ? t.rawDescription : t.description,
      category: t.category ?? '',
      kind: t.kind,
      kindLabel: KIND_LABELS[t.kind] ?? t.kind,
      amountCents: t.amountCents,
      claimCents: c?.claimCents ?? 0,
      status: c?.status ?? 'excluded',
      reason: c?.reason ?? 'excluded',
      reasonLabel: REASON_LABELS[c?.reason] ?? '',
      note: t.note ?? '',
    };
  });
  const claimed = lines.filter((l) => l.claimCents !== 0);
  const excluded = lines.filter((l) => l.claimCents === 0);

  const reimbursements = bill.allocations
    .map((a) => ({ date: a.date, sender: a.sender, amountCents: a.amountCents, method: a.method }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const cardName = account?.nickname || account?.name || 'Card';
  return {
    title: settings.reportTitle || 'Expense Reimbursement Request',
    employee: { name: settings.yourName, email: settings.yourEmail },
    company: { name: settings.companyName, email: settings.companyEmail },
    zelleHandle: settings.zelleHandle,
    account: { label: accountLabel(account), name: cardName, mask: account?.mask ?? null, institution: account?.institution ?? null },
    bill: {
      id: bill.id,
      start: bill.start,
      end: bill.end,
      period: formatPeriod(bill.start, bill.end),
      closingLong: formatDateLong(bill.end),
      dueDate: bill.dueDate,
      paidOn: bill.paid.paid ? bill.paid.paidOn : null,
      paid: bill.paid.paid,
      submittedOn: bill.submittedOn,
      status: bill.status,
      statusLabel: billStatusLabel(bill),
      note: bill.note,
      stmtBalanceCents: bill.stmtBalanceCents,
    },
    lines,
    claimed,
    excluded,
    totals: {
      claimCents: bill.claimCents,
      chargesCents: bill.chargesCents,
      creditsCents: bill.creditsCents,
      excludedCents: bill.excludedCents,
      receivedCents: bill.receivedCents,
      outstandingCents: bill.outstandingCents,
      claimedCount: claimed.length,
      excludedCount: excluded.length,
    },
    reimbursements,
    generatedOn: ledger.today,
    filenameBase: `Expenses_${slug(cardName)}${account?.mask ? `-${account.mask}` : ''}_${bill.start}_to_${bill.end}`,
  };
}
