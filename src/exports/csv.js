import { toCSV } from '../lib/csv.js';
import { centsToDecimal } from '../lib/money.js';
import { formatDateUS } from '../lib/dates.js';
import { STATUS_LABELS, accountLabel } from './report.js';

/**
 * CSV for the company: one row per claimed transaction and a total.
 * @param {ReturnType<import('./report.js').billReport>} r
 * @param {{ includeExcluded?: boolean }} opts
 */
export function companyCSV(r, { includeExcluded = false } = {}) {
  const rows = [['Date', 'Merchant', 'Description', 'Category', 'Business purpose', 'Amount charged', 'Amount claimed', 'Status']];
  const push = (l) =>
    rows.push([
      formatDateUS(l.date),
      l.merchant,
      l.description,
      l.category,
      l.note,
      centsToDecimal(l.amountCents),
      centsToDecimal(l.claimCents),
      l.status === 'excluded' ? 'Not claimed (personal)' : l.status === 'partial' ? 'Partly claimed' : 'Claimed',
    ]);
  r.claimed.forEach(push);
  if (includeExcluded) r.excluded.forEach(push);
  rows.push([]);
  rows.push(['', '', '', '', 'Total reimbursement requested', '', centsToDecimal(r.totals.claimCents), '']);
  rows.push([]);
  rows.push(['Card', r.account.label]);
  rows.push(['Statement period', `${formatDateUS(r.bill.start)} - ${formatDateUS(r.bill.end)}`]);
  if (r.bill.paidOn) rows.push(['Statement paid on', formatDateUS(r.bill.paidOn)]);
  if (r.employee.name) rows.push(['Submitted by', r.employee.email ? `${r.employee.name} (${r.employee.email})` : r.employee.name]);
  if (r.zelleHandle) rows.push(['Reimburse via Zelle to', r.zelleHandle]);
  return toCSV(rows, { bom: true });
}

/**
 * CSV for your own records: every transaction with its claim status, plus the
 * bill's reimbursement status.
 * @param {ReturnType<import('./report.js').billReport>} r
 */
export function trackingCSV(r) {
  const rows = [
    [
      'Card',
      'Statement start',
      'Statement closing',
      'Transaction date',
      'Post date',
      'Merchant',
      'Description',
      'Category',
      'Type',
      'Amount',
      'Claimed',
      'Claim status',
      'Note',
      'Bill status',
      'Bill received',
      'Bill outstanding',
    ],
  ];
  for (const l of r.lines) {
    rows.push([
      r.account.label,
      r.bill.start,
      r.bill.end,
      l.date,
      l.postDate,
      l.merchant,
      l.description,
      l.category,
      l.kindLabel,
      centsToDecimal(l.amountCents),
      centsToDecimal(l.claimCents),
      l.reasonLabel,
      l.note,
      r.bill.statusLabel,
      centsToDecimal(r.totals.receivedCents),
      centsToDecimal(r.totals.outstandingCents),
    ]);
  }
  return toCSV(rows, { bom: true });
}

/**
 * One row per bill across all cards.
 * @param {import('../store/model.js').Snapshot} snapshot
 * @param {ReturnType<import('../core/ledger.js').buildLedger>} ledger
 */
export function ledgerCSV(snapshot, ledger) {
  const rows = [
    ['Card', 'Statement start', 'Statement closing', 'Due date', 'Paid on', 'Submitted on', 'Charges', 'Excluded', 'Claimed', 'Received', 'Outstanding', 'Status'],
  ];
  for (const b of ledgerBills(ledger)) {
    rows.push([
      accountLabel(snapshot.accounts.get(b.accountId)),
      b.start,
      b.end,
      b.dueDate ?? '',
      b.paid.paid ? (b.paid.paidOn ?? '') : '',
      b.submittedOn ?? '',
      centsToDecimal(b.chargesCents + b.creditsCents),
      centsToDecimal(b.excludedCents),
      centsToDecimal(b.claimCents),
      centsToDecimal(b.receivedCents),
      centsToDecimal(b.outstandingCents),
      STATUS_LABELS[b.status] ?? b.status,
    ]);
  }
  return toCSV(rows, { bom: true });
}

export function ledgerBills(ledger) {
  return [...ledger.bills.values()].filter((b) => b.visible).sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : a.accountId < b.accountId ? -1 : 1));
}
